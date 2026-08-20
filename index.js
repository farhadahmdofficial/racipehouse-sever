
import dotenv from 'dotenv';
dotenv.config();

import express from 'express';
import cors from 'cors';
import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';
import { betterAuth } from 'better-auth';
import { mongodbAdapter } from 'better-auth/adapters/mongodb';
import { toNodeHandler } from 'better-auth/node';
import Stripe from 'stripe';
import { createRemoteJWKSet, jwtVerify } from 'jose-cjs';

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const app = express();
const port = process.env.PORT || 5000;

// 1. CORS Middleware
app.use(
  cors({
    origin: [
      process.env.CLIENT_URL,
      "http://localhost:3000",
      "https://racipehouse-client-theta.vercel.app"
    ],
    credentials: true,
  })
);

app.use(express.json());

// 🎯 Root Route
app.get('/', (req, res) => {
  res.status(200).send('RecipeHouse Server is Running Successfully!');
});

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error("❌ MONGODB_URI is not defined in .env file!");
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

// Cache DB connection for Serverless Architecture
let db, subscriptionCollection, userCollection, recipeCollection, paymentCollection, favoritesCollection, reportsCollection;

// Better Auth Holder Variable
let auth;

async function connectDB(req, res, next) {
  try {
    if (!db) {
      await client.connect();
      db = client.db("recipehouse");
      subscriptionCollection = db.collection("subscriptions");
      userCollection = db.collection("user");
      recipeCollection = db.collection("recipes");
      paymentCollection = db.collection("payment");
      favoritesCollection = db.collection("favorites");
      reportsCollection = db.collection("reports");

      // 🔐 Initialize Better Auth with Database instance
      auth = betterAuth({
        database: mongodbAdapter(db, { client: client }),
        emailAndPassword: { enabled: true },
        socialProviders: {
          google: {
            clientId: process.env.GOOGLE_CLIENT_ID,
            clientSecret: process.env.GOOGLE_CLIENT_SECRET,
          },
        },
        secret: process.env.BETTER_AUTH_SECRET,
        baseURL: process.env.BETTER_AUTH_URL || "https://recipehouse-sever.vercel.app",
        trustedOrigins: [
          "http://localhost:3000",
          "https://racipehouse-client-theta.vercel.app",
          process.env.CLIENT_URL
        ].filter(Boolean),
      });

      console.log("✅ MongoDB & Better Auth Connected Successfully!");
    }
    req.db = db;
    next();
  } catch (error) {
    console.error("MongoDB Connection Error:", error);
    res.status(500).json({ success: false, message: "Database Connection Failed" });
  }
}

// Global DB Middleware
app.use(connectDB);

// 🔐 Better Auth API Route Handler (Express Wildcard)
app.all("/api/auth/*", (req, res, next) => {
  if (!auth) {
    return res.status(500).json({ message: "Auth initialization pending" });
  }
  return toNodeHandler(auth)(req, res, next);
});

// JWKS Cache setup
const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL || 'https://racipehouse-client-theta.vercel.app'}/api/auth/jwks`));

// Verify Token Middleware
const verifyToken = async (req, res, next) => {
  const authheader = req.headers.authorization;

  if (!authheader || !authheader.startsWith("Bearer ")) {
    return res.status(401).send({ msg: "Unauthorized" });
  }

  const token = authheader.split(" ")[1];

  if (!token) {
    return res.status(401).send({ msg: "Unauthorized" });
  }

  try {
    const { payload } = await jwtVerify(token, JWKS);
    req.user = payload;
    next();
  } catch (error) {
    console.error("JWT Error:", error.message);
    return res.status(401).send({ msg: "Unauthorized" });
  }
};

// ---------------- API ROUTES ----------------

// Subscription Route
app.post("/subscription", async (req, res) => {
  try {
    const { user, session_id } = req.body;

    if (!user?.id || !session_id) {
      return res.status(400).json({ success: false, message: "User ID and session_id are required!" });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== "paid") {
      return res.status(400).json({ success: false, message: "Payment has not been completed." });
    }

    let userObjectId;
    try {
      userObjectId = new ObjectId(user.id);
    } catch (err) {
      return res.status(400).json({ success: false, message: "Invalid User ID format." });
    }

    const sub_result = await subscriptionCollection.insertOne({
      userId: userObjectId,
      session_id,
      amount: session.amount_total / 100,
      currency: session.currency,
      createdAt: new Date(),
    });

    const user_result = await userCollection.updateOne(
      { _id: userObjectId },
      { $set: { plan: "pro", isPremium: true, updatedAt: new Date() } }
    );

    return res.status(200).json({
      success: true,
      message: "Subscription verified and plan upgraded successfully!",
      sub_result,
      user_result,
    });

  } catch (error) {
    console.error("❌ Error in /subscription route:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error", error: error.message });
  }
});

// Payment Route
app.post("/payment", async (req, res) => {
  try {
    const { user, session_id } = req.body;

    if (!session_id) {
      return res.status(400).json({ success: false, message: "Session ID is required!" });
    }

    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== "paid") {
      return res.status(400).json({ success: false, message: "Payment has not been completed." });
    }

    const existingPayment = await paymentCollection.findOne({ session_id });
    if (existingPayment) {
      return res.status(200).json({
        success: true,
        message: "Payment has already been processed and recorded.",
        alreadyProcessed: true,
        data: existingPayment,
      });
    }

    const rawUserId = session.metadata?.userId || user?.id || req.body.userId;
    const rawRecipeId = session.metadata?.recipeId || req.body.recipeId;
    const recipeName = session.metadata?.name || req.body.name || "Recipe Purchase";
    const amountPaid = session.amount_total ? session.amount_total / 100 : Number(session.metadata?.price || req.body.price);

    let userObjectId = null;
    let recipeObjectId = null;

    if (rawUserId) {
      try { userObjectId = new ObjectId(rawUserId); } catch (err) { userObjectId = rawUserId; }
    }

    if (rawRecipeId) {
      try { recipeObjectId = new ObjectId(rawRecipeId); } catch (err) { recipeObjectId = rawRecipeId; }
    }

    const paymentData = {
      userId: userObjectId,
      recipeId: recipeObjectId,
      recipeName,
      price: amountPaid,
      currency: session.currency || "usd",
      session_id,
      paymentIntentId: session.payment_intent,
      customerEmail: session.customer_details?.email || user?.email,
      metadata: session.metadata || {},
      status: "completed",
      createdAt: new Date(),
    };

    const paymentResult = await paymentCollection.insertOne(paymentData);

    let userUpdateResult = null;
    if (userObjectId && recipeObjectId) {
      userUpdateResult = await userCollection.updateOne(
        { _id: userObjectId },
        {
          $addToSet: { purchasedRecipes: recipeObjectId },
          $set: { updatedAt: new Date() },
        }
      );
    }

    return res.status(200).json({
      success: true,
      message: "Payment verified and recorded successfully!",
      paymentId: paymentResult.insertedId,
      paymentResult,
      userUpdateResult,
    });

  } catch (error) {
    console.error("❌ Error in /payment route:", error);
    return res.status(500).json({ success: false, message: "Internal Server Error", error: error.message });
  }
});

// Post Recipe API
app.post("/recipes", verifyToken, async (req, res) => {
  try {
    const recipeData = req.body;

    if (!recipeData.name || !recipeData.ingredients) {
      return res.status(400).json({ success: false, message: "Recipe name and ingredients are required!" });
    }

    const newRecipe = {
      ...recipeData,
      price: Number(recipeData.price) || 0,
      createdAt: new Date(),
      status: "approved"
    };

    const result = await recipeCollection.insertOne(newRecipe);

    res.status(201).json({
      success: true,
      message: "Recipe created successfully!",
      insertedId: result.insertedId
    });

  } catch (error) {
    console.error("Error creating recipe:", error);
    res.status(500).json({ success: false, message: "Failed to create recipe", error: error.message });
  }
});

// Recipe Like Update API
app.patch('/recipes/:id/like', async (req, res) => {
  const { id } = req.params;
  const { userId, isLiked } = req.body;

  try {
    const query = { _id: new ObjectId(id) };
    const update = isLiked
      ? { $addToSet: { likedBy: userId }, $inc: { likesCount: 1 } }
      : { $pull: { likedBy: userId }, $inc: { likesCount: -1 } };

    const result = await recipeCollection.updateOne(query, update);
    res.send({ success: true, result });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

// Add/Remove Favorite API
app.post('/users/favorites', async (req, res) => {
  const { userId, recipeId, isFavorite } = req.body;

  try {
    if (isFavorite) {
      await favoritesCollection.updateOne(
        { userId, recipeId },
        { $set: { userId, recipeId, createdAt: new Date() } },
        { upsert: true }
      );
      await recipeCollection.updateOne(
        { _id: new ObjectId(recipeId) },
        { $addToSet: { favoritedBy: userId } }
      );
    } else {
      await favoritesCollection.deleteOne({ userId, recipeId });
      await recipeCollection.updateOne(
        { _id: new ObjectId(recipeId) },
        { $pull: { favoritedBy: userId } }
      );
    }
    res.send({ success: true });
  } catch (error) {
    res.status(500).send({ success: false, message: error.message });
  }
});

// GET Favorites list
app.get('/api/recipes/favorites', async (req, res) => {
  try {
    const { userId, userEmail } = req.query;

    if (!userId && !userEmail) {
      return res.status(400).json({ success: false, message: "User identity required" });
    }

    const filterConditions = [];
    if (userId) filterConditions.push({ userId: userId });
    if (userEmail) filterConditions.push({ userEmail: userEmail });

    const userFavorites = await favoritesCollection.find({ $or: filterConditions }).toArray();

    const populatedFavorites = await Promise.all(
      userFavorites.map(async (fav) => {
        let recipe = null;
        if (fav.recipeId) {
          try {
            recipe = await recipeCollection.findOne({ _id: new ObjectId(fav.recipeId) });
          } catch (e) {
            recipe = await recipeCollection.findOne({ _id: fav.recipeId });
          }
        }
        return {
          _id: fav._id,
          userId: fav.userId,
          recipe: recipe || fav.recipe || null
        };
      })
    );

    const validFavorites = populatedFavorites.filter(item => item.recipe !== null);

    res.status(200).json({ success: true, favorites: validFavorites });
  } catch (error) {
    console.error("Fetch favorites error:", error);
    res.status(500).json({ success: false, message: error.message });
  }
});

// DELETE Favorite recipe
app.delete('/api/recipes/favorites', async (req, res) => {
  try {
    const { favoriteId } = req.body;
    let query = ObjectId.isValid(favoriteId) ? { _id: new ObjectId(favoriteId) } : { _id: favoriteId };

    const result = await favoritesCollection.deleteOne(query);

    if (result.deletedCount > 0) {
      return res.status(200).json({ success: true, message: "Removed successfully" });
    } else {
      return res.status(404).json({ success: false, message: "Item not found" });
    }
  } catch (error) {
    res.status(500).json({ success: false, message: error.message });
  }
});

// Popular Recipes API
app.get('/api/popular-recipes', async (req, res) => {
  try {
    const popularRecipes = await recipeCollection
      .find({})
      .sort({ likesCount: -1 })
      .limit(3)
      .toArray();

    res.status(200).json({ success: true, recipes: popularRecipes });
  } catch (error) {
    console.error('Error fetching popular recipes:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch popular recipes' });
  }
});

// GET Recipes API
app.get('/recipes', async (req, res) => {
  try {
    const page = parseInt(req.query.page) || 1;
    const limit = parseInt(req.query.limit) || 10;
    const skip = (page - 1) * limit;

    const recipes = await recipeCollection.find().skip(skip).limit(limit).toArray();
    const totalCount = await recipeCollection.countDocuments();
    const totalPages = Math.ceil(totalCount / limit);

    res.status(200).json({
      success: true,
      recipes,
      totalPages,
      totalCount,
      currentPage: page,
    });
  } catch (error) {
    console.error('Error fetching recipes:', error);
    res.status(500).json({ success: false, message: 'Server error' });
  }
});

// My Recipes
app.get('/myrecipes', async (req, res) => {
  const result = await recipeCollection.find().toArray();
  res.send(result);
});

// Submit Report
app.post('/api/reports', async (req, res) => {
  try {
    const { recipeId, recipeTitle, reportedByEmail, userId, reason } = req.body;

    if (!recipeId || !reason) {
      return res.status(400).json({ success: false, message: 'Missing required fields' });
    }

    const newReport = {
      recipeId: String(recipeId),
      recipeTitle: recipeTitle || 'Untitled Recipe',
      reportedByEmail: reportedByEmail || 'Anonymous',
      userId: userId || null,
      reason,
      createdAt: new Date(),
    };

    const result = await reportsCollection.insertOne(newReport);
    res.status(201).json({ success: true, message: 'Report submitted successfully', insertedId: result.insertedId });
  } catch (error) {
    console.error('Report submission error:', error);
    res.status(500).json({ success: false, message: 'Internal server error' });
  }
});

// Get Admin Reports
app.get('/api/admin/reports', async (req, res) => {
  try {
    const reports = await reportsCollection.find({}).sort({ createdAt: -1 }).toArray();
    res.status(200).json({ success: true, reports });
  } catch (error) {
    console.error('Error fetching reports:', error);
    res.status(500).json({ success: false, message: 'Failed to fetch reports' });
  }
});

// Delete Admin Reports / Remove Recipe
app.delete('/api/admin/reports', async (req, res) => {
  try {
    const { reportId, recipeId, action } = req.body;

    if (action === 'remove_recipe') {
      if (recipeId && ObjectId.isValid(recipeId)) {
        await recipeCollection.deleteOne({ _id: new ObjectId(recipeId) });
      }
      if (recipeId) {
        await reportsCollection.deleteMany({ recipeId: String(recipeId) });
      }
    } else {
      if (reportId && ObjectId.isValid(reportId)) {
        await reportsCollection.deleteOne({ _id: new ObjectId(reportId) });
      } else {
        return res.status(400).json({ success: false, message: 'Invalid reportId format' });
      }
    }

    res.status(200).json({ success: true, message: 'Action completed successfully' });
  } catch (error) {
    console.error('Report action error:', error);
    res.status(500).json({ success: false, message: 'Action failed' });
  }
});

// Get Single Recipe by ID
app.get("/recipes/:id", async (req, res) => {
  const { id } = req.params;
  const result = await recipeCollection.findOne({ _id: new ObjectId(id) });
  res.send(result);
});

// Export app for Vercel Serverless
export default app;

if (process.env.NODE_ENV !== "production") {
  app.listen(port, () => {
    console.log(`🚀 Local Server running on port ${port}`);
  });
}
















// import dotenv from 'dotenv';
// dotenv.config();

// import express from 'express';
// import cors from 'cors';
// import { MongoClient, ServerApiVersion, ObjectId } from 'mongodb';
// import { betterAuth } from 'better-auth';
// import { mongodbAdapter } from 'better-auth/adapters/mongodb';
// import { toNodeHandler } from 'better-auth/node';
// import { jwt } from 'better-auth/plugins';
// import Stripe from 'stripe';
// // import { createRemoteJWKSet, jwtVerify } from 'jose';
// import { createRemoteJWKSet, jwtVerify } from 'jose-cjs';


// // Stripe Initialize
// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// const app = express();
// const port = process.env.PORT || 5000;

// // 1. CORS Middleware
// app.use(
//   cors({
//     origin: [process.env.CLIENT_URL, "http://localhost:3000"],
//     credentials: true,
//   })
// );

// // 2. Body Parser Middleware
// app.use(express.json());

// // 🎯 Root Route (Global Scope-এ রাখা হয়েছে যাতে Vercel সহজে খুঁজে পায়)
// app.get('/', (req, res) => {
//   res.status(200).send('RecipeHouse Server is Running Successfully!');
// });

// const uri = process.env.MONGODB_URI;

// if (!uri) {
//   console.error("❌ MONGODB_URI is not defined in .env file!");
// }

// const client = new MongoClient(uri, {
//   serverApi: {
//     version: ServerApiVersion.v1,
//     strict: true,
//     deprecationErrors: true,
//   }
// });

// // JWKS Cache setup
// const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL || 'http://localhost:3000'}/api/auth/jwks`));

// // Verify Token Middleware
// const verifyToken = async (req, res, next) => {
//   const authheader = req.headers.authorization;

//   if (!authheader || !authheader.startsWith("Bearer ")) {
//     return res.status(401).send({ msg: "Unauthorized" });
//   }

//   const token = authheader.split(" ")[1];

//   if (!token) {
//     return res.status(401).send({ msg: "Unauthorized" });
//   }

//   try {
//     const { payload } = await jwtVerify(token, JWKS);
//     req.user = payload;
//     next();
//   } catch (error) {
//     console.error("JWT Error:", error.message);
//     return res.status(401).send({ msg: "Unauthorized" });
//   }
// };

// async function run() {
//   try {
//     await client.connect();
//     const db = client.db("recipehouse");
//     const subscriptionCollection = db.collection("subscriptions");
//     const userCollection = db.collection("user");
//     const recipeCollection = db.collection("recipes");
//     const paymentCollection = db.collection("payment");

//     console.log("✅ MongoDB Connected Successfully!");

//     // Better Auth Setup
//     const auth = betterAuth({
//       database: mongodbAdapter(db, { client: client }),
//       emailAndPassword: { enabled: true },
//       socialProviders: {
//         google: { 
//           clientId: process.env.GOOGLE_CLIENT_ID,
//           clientSecret: process.env.GOOGLE_CLIENT_SECRET,
//         },
//       },
//       user: {
//         additionalFields: {
//           role: { type: "string", required: false, defaultValue: "user", input: true },
//           plan: { type: "string", required: false, defaultValue: "free", input: true },
//           image: { type: "string", required: false, input: true },
//           isPremium: { type: "boolean", required: false, defaultValue: false },
//           totalRecipes: { type: "number", required: false, defaultValue: 0 },
//           totalFavorites: { type: "number", required: false, defaultValue: 0 },
//           totalLikesReceived: { type: "number", required: false, defaultValue: 0 },
//         },
//       },
//       session: {
//         cookieCache: {
//           enabled: true,
//           strategy: "jwt",
//           maxAge: 60 * 60 * 24 * 7,
//         },
//       },
//       plugins: [jwt()],
//       secret: process.env.BETTER_AUTH_SECRET || "super-secret-key-12345",
//       baseURL: `http://localhost:${port}`,
//       trustedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
//     });

//     // Better Auth Handler
//     app.all("/api/auth/*splat", toNodeHandler(auth));

//     // Subscription Route
//     app.post("/subscription", async (req, res) => {
//       try {
//         const { user, session_id } = req.body;

//         if (!user?.id || !session_id) {
//           return res.status(400).json({ success: false, message: "User ID and session_id are required!" });
//         }

//         const session = await stripe.checkout.sessions.retrieve(session_id);

//         if (session.payment_status !== "paid") {
//           return res.status(400).json({ success: false, message: "Payment has not been completed." });
//         }

//         let userObjectId;
//         try {
//           userObjectId = new ObjectId(user.id);
//         } catch (err) {
//           return res.status(400).json({ success: false, message: "Invalid User ID format." });
//         }

//         const sub_result = await subscriptionCollection.insertOne({
//           userId: userObjectId,
//           session_id,
//           amount: session.amount_total / 100,
//           currency: session.currency,
//           createdAt: new Date(),
//         });

//         const user_result = await userCollection.updateOne(
//           { _id: userObjectId },
//           { $set: { plan: "pro", isPremium: true, updatedAt: new Date() } }
//         );

//         return res.status(200).json({
//           success: true,
//           message: "Subscription verified and plan upgraded successfully!",
//           sub_result,
//           user_result,
//         });

//       } catch (error) {
//         console.error("❌ Error in /subscription route:", error);
//         return res.status(500).json({ success: false, message: "Internal Server Error", error: error.message });
//       }
//     });

//     // Payment Route
//     app.post("/payment", async (req, res) => {
//       try {
//         const { user, session_id } = req.body;

//         if (!session_id) {
//           return res.status(400).json({ success: false, message: "Session ID is required!" });
//         }

//         const session = await stripe.checkout.sessions.retrieve(session_id);

//         if (session.payment_status !== "paid") {
//           return res.status(400).json({ success: false, message: "Payment has not been completed." });
//         }

//         const existingPayment = await paymentCollection.findOne({ session_id });
//         if (existingPayment) {
//           return res.status(200).json({
//             success: true,
//             message: "Payment has already been processed and recorded.",
//             alreadyProcessed: true,
//             data: existingPayment,
//           });
//         }

//         const rawUserId = session.metadata?.userId || user?.id || req.body.userId;
//         const rawRecipeId = session.metadata?.recipeId || req.body.recipeId;
//         const recipeName = session.metadata?.name || req.body.name || "Recipe Purchase";
//         const amountPaid = session.amount_total ? session.amount_total / 100 : Number(session.metadata?.price || req.body.price);

//         let userObjectId = null;
//         let recipeObjectId = null;

//         if (rawUserId) {
//           try { userObjectId = new ObjectId(rawUserId); } catch (err) { userObjectId = rawUserId; }
//         }

//         if (rawRecipeId) {
//           try { recipeObjectId = new ObjectId(rawRecipeId); } catch (err) { recipeObjectId = rawRecipeId; }
//         }

//         const paymentData = {
//           userId: userObjectId,
//           recipeId: recipeObjectId,
//           recipeName,
//           price: amountPaid,
//           currency: session.currency || "usd",
//           session_id,
//           paymentIntentId: session.payment_intent,
//           customerEmail: session.customer_details?.email || user?.email,
//           metadata: session.metadata || {},
//           status: "completed",
//           createdAt: new Date(),
//         };

//         const paymentResult = await paymentCollection.insertOne(paymentData);

//         let userUpdateResult = null;
//         if (userObjectId && recipeObjectId) {
//           userUpdateResult = await userCollection.updateOne(
//             { _id: userObjectId },
//             {
//               $addToSet: { purchasedRecipes: recipeObjectId },
//               $set: { updatedAt: new Date() },
//             }
//           );
//         }

//         return res.status(200).json({
//           success: true,
//           message: "Payment verified and recorded successfully!",
//           paymentId: paymentResult.insertedId,
//           paymentResult,
//           userUpdateResult,
//         });

//       } catch (error) {
//         console.error("❌ Error in /payment route:", error);
//         return res.status(500).json({ success: false, message: "Internal Server Error", error: error.message });
//       }
//     });

//     // Post Recipe API
//     app.post("/recipes", verifyToken, async (req, res) => {
//       try {
//         const recipeData = req.body;

//         if (!recipeData.name || !recipeData.ingredients) {
//           return res.status(400).json({ success: false, message: "Recipe name and ingredients are required!" });
//         }

//         const newRecipe = {
//           ...recipeData,
//           price: Number(recipeData.price) || 0,
//           createdAt: new Date(),
//           status: "approved"
//         };

//         const result = await recipeCollection.insertOne(newRecipe);

//         res.status(201).json({
//           success: true,
//           message: "Recipe created successfully!",
//           insertedId: result.insertedId
//         });

//       } catch (error) {
//         console.error("Error creating recipe:", error);
//         res.status(500).json({ success: false, message: "Failed to create recipe", error: error.message });
//       }
//     });

//     // Recipe Like Update API
//     app.patch('/recipes/:id/like', async (req, res) => {
//       const { id } = req.params;
//       const { userId, isLiked } = req.body;

//       try {
//         const query = { _id: new ObjectId(id) };
//         const update = isLiked
//           ? { $addToSet: { likedBy: userId }, $inc: { likesCount: 1 } }
//           : { $pull: { likedBy: userId }, $inc: { likesCount: -1 } };

//         const result = await db.collection('recipes').updateOne(query, update);
//         res.send({ success: true, result });
//       } catch (error) {
//         res.status(500).send({ success: false, message: error.message });
//       }
//     });

//     // Add/Remove Favorite API
//     app.post('/users/favorites', async (req, res) => {
//       const { userId, recipeId, isFavorite } = req.body;

//       try {
//         if (isFavorite) {
//           await db.collection('favorites').updateOne(
//             { userId, recipeId },
//             { $set: { userId, recipeId, createdAt: new Date() } },
//             { upsert: true }
//           );
//           await db.collection('recipes').updateOne(
//             { _id: new ObjectId(recipeId) },
//             { $addToSet: { favoritedBy: userId } }
//           );
//         } else {
//           await db.collection('favorites').deleteOne({ userId, recipeId });
//           await db.collection('recipes').updateOne(
//             { _id: new ObjectId(recipeId) },
//             { $pull: { favoritedBy: userId } }
//           );
//         }
//         res.send({ success: true });
//       } catch (error) {
//         res.status(500).send({ success: false, message: error.message });
//       }
//     });

//     // GET Favorites list
//     app.get('/api/recipes/favorites', async (req, res) => {
//       try {
//         const { userId, userEmail } = req.query;

//         if (!userId && !userEmail) {
//           return res.status(400).json({ success: false, message: "User identity required" });
//         }

//         const filterConditions = [];
//         if (userId) filterConditions.push({ userId: userId });
//         if (userEmail) filterConditions.push({ userEmail: userEmail });

//         const userFavorites = await db.collection('favorites').find({ $or: filterConditions }).toArray();

//         const populatedFavorites = await Promise.all(
//           userFavorites.map(async (fav) => {
//             let recipe = null;
//             if (fav.recipeId) {
//               try {
//                 recipe = await db.collection('recipes').findOne({ _id: new ObjectId(fav.recipeId) });
//               } catch (e) {
//                 recipe = await db.collection('recipes').findOne({ _id: fav.recipeId });
//               }
//             }
//             return {
//               _id: fav._id,
//               userId: fav.userId,
//               recipe: recipe || fav.recipe || null
//             };
//           })
//         );

//         const validFavorites = populatedFavorites.filter(item => item.recipe !== null);

//         res.status(200).json({ success: true, favorites: validFavorites });
//       } catch (error) {
//         console.error("Fetch favorites error:", error);
//         res.status(500).json({ success: false, message: error.message });
//       }
//     });

//     // DELETE Favorite recipe
//     app.delete('/api/recipes/favorites', async (req, res) => {
//       try {
//         const { favoriteId } = req.body;
//         let query = ObjectId.isValid(favoriteId) ? { _id: new ObjectId(favoriteId) } : { _id: favoriteId };

//         const result = await db.collection('favorites').deleteOne(query);

//         if (result.deletedCount > 0) {
//           return res.status(200).json({ success: true, message: "Removed successfully" });
//         } else {
//           return res.status(404).json({ success: false, message: "Item not found" });
//         }
//       } catch (error) {
//         res.status(500).json({ success: false, message: error.message });
//       }
//     });

//     // Popular Recipes API
//     app.get('/api/popular-recipes', async (req, res) => {
//       try {
//         const popularRecipes = await db.collection('recipes')
//           .find({})
//           .sort({ likesCount: -1 })
//           .limit(3)
//           .toArray();

//         res.status(200).json({ success: true, recipes: popularRecipes });
//       } catch (error) {
//         console.error('Error fetching popular recipes:', error);
//         res.status(500).json({ success: false, message: 'Failed to fetch popular recipes' });
//       }
//     });

//     // GET Recipes API
//     app.get('/recipes', async (req, res) => {
//       try {
//         const page = parseInt(req.query.page) || 1;
//         const limit = parseInt(req.query.limit) || 10;
//         const skip = (page - 1) * limit;

//         const recipes = await recipeCollection.find().skip(skip).limit(limit).toArray();
//         const totalCount = await recipeCollection.countDocuments();
//         const totalPages = Math.ceil(totalCount / limit);

//         res.status(200).json({
//           success: true,
//           recipes,
//           totalPages,
//           totalCount,
//           currentPage: page,
//         });
//       } catch (error) {
//         console.error('Error fetching recipes:', error);
//         res.status(500).json({ success: false, message: 'Server error' });
//       }
//     });

//     // My Recipes
//     app.get('/myrecipes', async (req, res) => {
//       const result = await recipeCollection.find().toArray();
//       res.send(result);
//     });

//     // Submit Report
//     app.post('/api/reports', async (req, res) => {
//       try {
//         const { recipeId, recipeTitle, reportedByEmail, userId, reason } = req.body;

//         if (!recipeId || !reason) {
//           return res.status(400).json({ success: false, message: 'Missing required fields' });
//         }

//         const newReport = {
//           recipeId: String(recipeId),
//           recipeTitle: recipeTitle || 'Untitled Recipe',
//           reportedByEmail: reportedByEmail || 'Anonymous',
//           userId: userId || null,
//           reason,
//           createdAt: new Date(),
//         };

//         const result = await db.collection('reports').insertOne(newReport);
//         res.status(201).json({ success: true, message: 'Report submitted successfully', insertedId: result.insertedId });
//       } catch (error) {
//         console.error('Report submission error:', error);
//         res.status(500).json({ success: false, message: 'Internal server error' });
//       }
//     });

//     // Get Admin Reports
//     app.get('/api/admin/reports', async (req, res) => {
//       try {
//         const reports = await db.collection('reports').find({}).sort({ createdAt: -1 }).toArray();
//         res.status(200).json({ success: true, reports });
//       } catch (error) {
//         console.error('Error fetching reports:', error);
//         res.status(500).json({ success: false, message: 'Failed to fetch reports' });
//       }
//     });

//     // Delete Admin Reports / Remove Recipe
//     app.delete('/api/admin/reports', async (req, res) => {
//       try {
//         const { reportId, recipeId, action } = req.body;

//         if (action === 'remove_recipe') {
//           if (recipeId && ObjectId.isValid(recipeId)) {
//             await db.collection('recipes').deleteOne({ _id: new ObjectId(recipeId) });
//           }
//           if (recipeId) {
//             await db.collection('reports').deleteMany({ recipeId: String(recipeId) });
//           }
//         } else {
//           if (reportId && ObjectId.isValid(reportId)) {
//             await db.collection('reports').deleteOne({ _id: new ObjectId(reportId) });
//           } else {
//             return res.status(400).json({ success: false, message: 'Invalid reportId format' });
//           }
//         }

//         res.status(200).json({ success: true, message: 'Action completed successfully' });
//       } catch (error) {
//         console.error('Report action error:', error);
//         res.status(500).json({ success: false, message: 'Action failed' });
//       }
//     });

//     // Get Single Recipe by ID
//     app.get("/recipes/:id", async (req, res) => {
//       const { id } = req.params;
//       const result = await recipeCollection.findOne({ _id: new ObjectId(id) });
//       res.send(result);
//     });

//   } catch (error) {
//     console.error("MongoDB Connection Error:", error);
//   }
// }

// // Start database logic
// run().catch(console.dir);

// // Export app for Vercel Serverless Function
// export default app;

// // Local testing execution
// if (process.env.NODE_ENV !== "production") {
//   app.listen(port, () => {
//     console.log(`🚀 Local Server running on port ${port}`);
//   });
// }









// ok code 



// require('dotenv').config();
// const express = require('express');
// const cors = require('cors');
// // const { ObjectId } = require('mongodb');
// const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
// const { betterAuth } = require('better-auth');
// const { mongodbAdapter } = require('better-auth/adapters/mongodb');
// const { toNodeHandler } = require('better-auth/node');
// const { jwt } = require('better-auth/plugins');
// const Stripe = require('stripe');
// const { createRemoteJWKSet, jwtVerify } = require('jose-cjs');



// // const { MongoClient, ObjectId } = require('mongodb');
// // const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb'); 

// // Stripe Initialize
// const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

// const app = express();
// const port = process.env.PORT || 5000;

// // 1. CORS Middleware
// app.use(
//   cors({
//     origin: [process.env.CLIENT_URL, "http://localhost:3000"],
//     credentials: true,
//   })
// );

// // 2. Body Parser Middleware (অবশ্যই Route এবং Auth-এর আগে থাকতে হবে)
// app.use(express.json());

// const uri = process.env.MONGODB_URI;

// if (!uri) {
//   console.error("❌ MONGODB_URI is not defined in .env file!");
//   process.exit(1);
// }

// const client = new MongoClient(uri, {
//   serverApi: {
//     version: ServerApiVersion.v1,
//     strict: true,
//     deprecationErrors: true,
//   }
// });

// async function run() {
//   try {
//     await client.connect();
//     const db = client.db("recipehouse");
//     const subscriptionCollection = db.collection("subscriptions");
//     const userCollection = db.collection("user");
//     const recipeCollection = db.collection("recipes");
//     const paymentCollection = db.collection("payment");

//     console.log("✅ MongoDB Connected Successfully!");

//     // Better Auth Setup
//     const auth = betterAuth({
//       database: mongodbAdapter(db, {
//         client: client,
//       }),
//       emailAndPassword: {
//         enabled: true,
//       },
//       socialProviders: {
//         google: { 
//           clientId: process.env.GOOGLE_CLIENT_ID,
//           clientSecret: process.env.GOOGLE_CLIENT_SECRET,
//         },
//       },
//       user: {
//         additionalFields: {
//           role: {
//             type: "string",
//             required: false,
//             defaultValue: "user",
//             input: true,
//           },
//           plan: {
//             type: "string",
//             required: false,
//             defaultValue: "free",
//             input: true,
//           },
//           image: {
//             type: "string",
//             required: false,
//             input: true,
//           },
//           isPremium: {
//             type: "boolean",
//             required: false,
//             defaultValue: false,
//           },
//           totalRecipes: {
//             type: "number",
//             required: false,
//             defaultValue: 0,
//           },
//           totalFavorites: {
//             type: "number",
//             required: false,
//             defaultValue: 0,
//           },
//           totalLikesReceived: {
//             type: "number",
//             required: false,
//             defaultValue: 0,
//           },
//         },
//       },
//       session: {
//         cookieCache: {
//           enabled: true,
//           strategy: "jwt",
//           maxAge: 60 * 60 * 24 * 7, // 7 Days
//         },
//       },
//       plugins: [jwt()],
//       secret: process.env.BETTER_AUTH_SECRET || "super-secret-key-12345",
//       baseURL: `http://localhost:${port}`,
//       trustedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
//     });

//     // Better Auth Handler
//     app.all("/api/auth/*splat", toNodeHandler(auth));





//     // 🎯 Subscription & Plan Update Route

// //     app.post("/subscription", async (req, res) => {
// //   try {
// //     const { user, session_id } = req.body;

// //     // ১. প্রয়োজনীয় ডাটা আছে কিনা চেক
// //     if (!user?.id || !session_id) {
// //       return res.status(400).json({ 
// //         success: false, 
// //         message: "User ID and session_id are required!" 
// //       });
// //     }

// //     // 🎯 ২. ডুপ্লিকেট চেক: এই session_id কি আগেই প্রসেস করা হয়েছে?
// //     const existingSub = await subscriptionCollection.findOne({ session_id });

// //     if (existingSub) {
// //       // ডাটা আগেই যুক্ত হয়ে গেছে, তাই নতুন করে ইনসার্ট না করে সফল মেসেজ ফেরত দিন
// //       return res.status(200).json({
// //         success: true,
// //         message: "Subscription already processed!",
// //         alreadyProcessed: true,
// //       });
// //     }

// //     // ৩. Stripe থেকে পেমেন্ট স্ট্যাটাস ভেরিফাই করা
// //     const session = await stripe.checkout.sessions.retrieve(session_id);

// //     if (session.payment_status !== "paid") {
// //       return res.status(400).json({ 
// //         success: false, 
// //         message: "Payment has not been completed." 
// //       });
// //     }

// //     // ৪. ObjectId সেফ কাস্টিং
// //     let userObjectId;
// //     try {
// //       userObjectId = new ObjectId(user.id);
// //     } catch (err) {
// //       return res.status(400).json({ 
// //         success: false, 
// //         message: "Invalid User ID format." 
// //       });
// //     }

// //     // ৫. Subscriptions কালেকশনে এন্ট্রি তৈরি (প্রথমবার হলে)
// //     const sub_result = await subscriptionCollection.insertOne({
// //       userId: userObjectId,
// //       session_id,
// //       amount: session.amount_total / 100,
// //       currency: session.currency,
// //       createdAt: new Date(),
// //     });

// //     // ৬. User কালেকশনে প্রিমিয়াম স্ট্যাটাস আপডেট
// //     const user_result = await userCollection.updateOne(
// //       { _id: userObjectId },
// //       { 
// //         $set: { 
// //           plan: "pro",
// //           isPremium: true,
// //           updatedAt: new Date()
// //         } 
// //       }
// //     );

// //     // ৭. সফল রেসপন্স
// //     return res.status(200).json({
// //       success: true,
// //       message: "Subscription verified and plan upgraded successfully!",
// //       sub_result,
// //       user_result,
// //     });

// //   } catch (error) {
// //     console.error("❌ Error in /subscription route:", error);
// //     return res.status(500).json({ 
// //       success: false, 
// //       message: "Internal Server Error", 
// //       error: error.message 
// //     });
// //   }
// // });





//     app.post("/subscription", async (req, res) => {
//   try {
//     const { user, session_id } = req.body;

//     // ১. প্রয়োজনীয় ডাটা আছে কিনা চেক
//     if (!user?.id || !session_id) {
//       return res.status(400).json({ 
//         success: false, 
//         message: "User ID and session_id are required!" 
//       });
//     }

//     // ২. Stripe থেকে পেমেন্ট স্ট্যাটাস ভেরিফাই করা
//     const session = await stripe.checkout.sessions.retrieve(session_id);

//     if (session.payment_status !== "paid") {
//       return res.status(400).json({ 
//         success: false, 
//         message: "Payment has not been completed." 
//       });
//     }

//     // ৩. ObjectId সেফ কাস্টিং
//     let userObjectId;
//     try {
//       userObjectId = new ObjectId(user.id);
//     } catch (err) {
//       return res.status(400).json({ 
//         success: false, 
//         message: "Invalid User ID format." 
//       });
//     }

//     // ৪. Subscriptions কালেকশনে এন্ট্রি তৈরি
//     const sub_result = await subscriptionCollection.insertOne({
//       userId: userObjectId,
//       session_id,
//       amount: session.amount_total / 100,
//       currency: session.currency,
//       createdAt: new Date(),
//     });

//     // ৫. User কালেকশনে প্রিমিয়াম স্ট্যাটাস আপডেট
//     const user_result = await userCollection.updateOne(
//       { _id: userObjectId },
//       { 
//         $set: { 
//           plan: "pro",
//           isPremium: true,
//           updatedAt: new Date()
//         } 
//       }
//     );

//     // ৬. সফল রেসপন্স
//     return res.status(200).json({
//       success: true,
//       message: "Subscription verified and plan upgraded successfully!",
//       sub_result,
//       user_result,
//     });

//   } catch (error) {
//     console.error("❌ Error in /subscription route:", error);
//     return res.status(500).json({ 
//       success: false, 
//       message: "Internal Server Error", 
//       error: error.message 
//     });
//   }
// });

// // new pro and free buge 
// // app.get("/check-subscription/:userId", async (req, res) => {
// //   try {
// //     const { userId } = req.params;

// //     // String এবং ObjectId উভয় ফরম্যাট দিয়ে সার্চ
// //     const query = {
// //       $or: [
// //         { userId: userId },
// //         ...(ObjectId.isValid(userId) ? [{ userId: new ObjectId(userId) }] : [])
// //       ]
// //     };

// //     const sub = await subscriptionCollection.findOne(query);

// //     if (sub) {
// //       return res.status(200).json({ isPro: true });
// //     }

// //     return res.status(200).json({ isPro: false });
// //   } catch (error) {
// //     return res.status(500).json({ isPro: false, error: error.message });
// //   }
// // });


// // payment 
// app.post("/payment", async (req, res) => {
//   try {
//     const { user, session_id } = req.body;

//     // ১. প্রয়োজনীয় ডাটা আছে কিনা চেক
//     if (!session_id) {
//       return res.status(400).json({
//         success: false,
//         message: "Session ID is required!",
//       });
//     }

//     // ২. Stripe থেকে পেমেন্ট সেসন রিট্রিভ করা
//     const session = await stripe.checkout.sessions.retrieve(session_id);

//     // পেমেন্ট কমপ্লিট হয়েছে কিনা ভেরিফাই করা
//     if (session.payment_status !== "paid") {
//       return res.status(400).json({
//         success: false,
//         message: "Payment has not been completed.",
//       });
//     }

//     // ৩. ডুপ্লিকেট এন্ট্রি রোধ (একই session_id আগে ডাটাবেজে সেভ হয়েছে কিনা চেক করা)
//     const existingPayment = await paymentCollection.findOne({ session_id });
//     if (existingPayment) {
//       return res.status(200).json({
//         success: true,
//         message: "Payment has already been processed and recorded.",
//         alreadyProcessed: true,
//         data: existingPayment,
//       });
//     }

//     // ৪. Stripe Metadata বা Request Body থেকে নিরাপদভাবে ডাটা নেওয়া
//     const rawUserId = session.metadata?.userId || user?.id || req.body.userId;
//     const rawRecipeId = session.metadata?.recipeId || req.body.recipeId;
//     const recipeName = session.metadata?.name || req.body.name || "Recipe Purchase";
//     const amountPaid = session.amount_total ? session.amount_total / 100 : Number(session.metadata?.price || req.body.price);

//     // ৫. ObjectId সেফ কাস্টিং
//     let userObjectId = null;
//     let recipeObjectId = null;

//     if (rawUserId) {
//       try {
//         userObjectId = new ObjectId(rawUserId);
//       } catch (err) {
//         userObjectId = rawUserId; // Fallback to String if not a valid ObjectId
//       }
//     }

//     if (rawRecipeId) {
//       try {
//         recipeObjectId = new ObjectId(rawRecipeId);
//       } catch (err) {
//         recipeObjectId = rawRecipeId;
//       }
//     }

//     // ৬. Payments কালেকশনে নতুন পেমেন্ট রেকর্ড তৈরি
//     const paymentData = {
//       userId: userObjectId,
//       recipeId: recipeObjectId,
//       recipeName,
//       price: amountPaid,
//       currency: session.currency || "usd",
//       session_id,
//       paymentIntentId: session.payment_intent,
//       customerEmail: session.customer_details?.email || user?.email,
//       metadata: session.metadata || {},
//       status: "completed",
//       createdAt: new Date(),
//     };

//     const paymentResult = await paymentCollection.insertOne(paymentData);

//     // ৭. ইউজার কালেকশনে কেনা রেসিপির ID যুক্ত করা
//     let userUpdateResult = null;
//     if (userObjectId && recipeObjectId) {
//       userUpdateResult = await userCollection.updateOne(
//         { _id: userObjectId },
//         {
//           $addToSet: { purchasedRecipes: recipeObjectId }, // ইউজার অ্যাকাউন্টে রেসিপি আইডি যুক্ত করা
//           $set: { updatedAt: new Date() },
//         }
//       );
//     }

//     // ৮. সফল রেসপন্স
//     return res.status(200).json({
//       success: true,
//       message: "Payment verified and recorded successfully!",
//       paymentId: paymentResult.insertedId,
//       paymentResult,
//       userUpdateResult,
//     });

//   } catch (error) {
//     console.error("❌ Error in /payment route:", error);
//     return res.status(500).json({
//       success: false,
//       message: "Internal Server Error",
//       error: error.message,
//     });
//   }
// });












// // app.post("/payment", async (req, res) => {
// //   try {
// //     const {metadata,price,name,recipeId,userId, user, session_id } = req.body;

// //     // ১. প্রয়োজনীয় ডাটা আছে কিনা চেক
// //     if (!session_id) {
// //       return res.status(400).json({
// //         success: false,
// //         message: "Session ID is required!",
// //       });
// //     }

// //     // ২. Stripe থেকে পেমেন্ট সেসন রিট্রিভ করা
// //     const session = await stripe.checkout.sessions.retrieve(session_id);

// //     // পেমেন্ট কমপ্লিট হয়েছে কিনা ভেরিফাই করা
// //     if (session.payment_status !== "paid") {
// //       return res.status(400).json({
// //         success: false,
// //         message: "Payment has not been completed.",
// //       });
// //     }

// //     // ৩. ডুপ্লিকেট এন্ট্রি রোধ (একই session_id আগে ডাটাবেজে সেভ হয়েছে কিনা চেক করা)
// //     const existingPayment = await paymentCollection.findOne({ session_id });
// //     if (existingPayment) {
// //       return res.status(200).json({
// //         success: true,
// //         message: "Payment has already been processed and recorded.",
// //         alreadyProcessed: true,
// //         data: existingPayment,
// //       });
// //     }

// //     // ৪. Stripe Metadata বা Request Body থেকে ডাটা নেওয়া
// //     const rawUserId = session.metadata?.userId || user?.id;
// //     const recipeId = session.metadata?.recipeId;
// //     const recipeName = session.metadata?.name || "Recipe Purchase";
// //     const price = session.metadata?.price || session.amount_total / 100;

// //     // ৫. ObjectId সেফ কাস্টিং
// //     let userObjectId = null;
// //     let recipeObjectId = null;

// //     if (rawUserId) {
// //       try {
// //         userObjectId = new ObjectId(rawUserId);
// //       } catch (err) {
// //         userObjectId = rawUserId; // String হিসেবে রাখা যদি ObjectId না হয়
// //       }
// //     }

// //     if (recipeId) {
// //       try {
// //         recipeObjectId = new ObjectId(recipeId);
// //       } catch (err) {
// //         recipeObjectId = recipeId;
// //       }
// //     }

// //     // ৬. Payments কালেকশনে নতুন পেমেন্ট রেকর্ড তৈরি
// //     const paymentData = {
// //       userId,
// //       recipeId,
     
// //       session_id,
// //       metadata,
// //       price,
// //       name,
// //       user,
      
   
    
     
     
// //     };

// //     const paymentResult = await paymentCollection.insertOne(paymentData);

// //     // ৭. (ঐচ্ছিক) ইউজার কালেকশনে কেনা রেসিপির ID যুক্ত করা
// //     let userUpdateResult = null;
// //     if (userObjectId && recipeObjectId) {
// //       userUpdateResult = await userCollection.updateOne(
// //         { _id: userObjectId },
// //         {
// //           $addToSet: { purchasedRecipes: recipeObjectId }, // ইউজার অ্যাকাউন্টে রেসিপি আইডি পুশ করা
// //           $set: { updatedAt: new Date() },
// //         }
// //       );
// //     }

// //     // ৮. সফল রেসপন্স
// //     return res.status(200).json({
// //       success: true,
// //       message: "Payment verified and recorded successfully!",
// //       paymentId: paymentResult.insertedId,
// //       paymentResult,
// //       userUpdateResult,
// //     });

// //   } catch (error) {
// //     console.error("❌ Error in /payment route:", error);
// //     return res.status(500).json({
// //       success: false,
// //       message: "Internal Server Error",
// //       error: error.message,
// //     });
// //   }
// // });








// const JWKS = createRemoteJWKSet(new URL(`${process.env.CLIENT_URL}/api/auth/jwks`));

// // Verify Token Middleware
// // index.js এর উপরের দিকে (আলাদা করে export করার দরকার নেই)
// const verifyToken = async (req, res, next) => {
//   const authheader = req.headers.authorization;

//   if (!authheader || !authheader.startsWith("Bearer ")) {
//     return res.status(401).send({ msg: "Unauthorized" });
//   }

//   const token = authheader.split(" ")[1];

//   if (!token) {
//     return res.status(401).send({ msg: "Unauthorized" });
//   }

//   try {
//     const { payload } = await jwtVerify(token, JWKS);
//     console.log(payload,"thsi payload");
//     req.user = payload;
//     next();
//   } catch (error) {
//     console.error("JWT Error:", error.message);
//     return res.status(401).send({ msg: "Unauthorized" });
//   }
// };

// // ok code 

// // const JWKS = createRemoteJWKSet(new url(`${process.env.CLIENT_URL}/api/auth/jwks`))

// // // verify tonke 

// // const verifyToken= async(req,res,next)=>{
// //   const authheader= req.headers.authorization

// //   if(!authheader || !authheader.startWith("Bearer")){
// //     res.status(401).send({msg:"Unauthrized"})
// //   }
// //   const token =authheader.split(" ")[1]
// //   if(!token){res.status(401).send({msg:"Unauthrized"})}
// //   try{
// //     const {payload}=await jwtVerify(token,JWKS)
// //     console.log(payload);
// //       next()

// //   }catch(error)
// //   {
// //     console.log(error);
// //     res.status(401).send({msg:"Unauthrized"})

// //   }

 

// // }








//     // recipe post api 
  
  
//   // post


// // app.get("/recipes", async (req, res) => {
// //   try {
// //     const page = parseInt(req.query.page) || 1;
// //     const limit = parseInt(req.query.limit) || 10;
// //     const skip = (page - 1) * limit;

// //     const { search, category, cuisine } = req.query;

// //     // ফিল্টারিং কুয়েরি
// //     let query = {};

// //     if (search) {
// //       query.name = { $regex: search, $options: "i" };
// //     }
// //     if (category) {
// //       query.category = category;
// //     }
// //     if (cuisine) {
// //       query.cuisine = cuisine;
// //     }

// //     const totalCount = await recipeCollection.countDocuments(query);
// //     const recipes = await recipeCollection
// //       .find(query)
// //       .skip(skip)
// //       .limit(limit)
// //       .sort({ createdAt: -1 })
// //       .toArray();

// //     const totalPages = Math.ceil(totalCount / limit);

// //     res.status(200).json({
// //       success: true,
// //       recipes,
// //       pagination: {
// //         totalCount,
// //         totalPages,
// //         currentPage: page,
// //         limit,
// //       },
// //     });
// //   } catch (error) {
// //     console.error("Error fetching recipes:", error);
// //     res.status(500).json({
// //       success: false,
// //       message: "Failed to fetch recipes",
// //       recipes: [],
// //     });
// //   }
// // });


//   // ok code 
//     app.post("/recipes",verifyToken, async (req, res) => {
//   try {
//     const recipeData = req.body;

//     // ১. প্রয়োজনীয় ফিল্ডগুলো চেক করা (Basic Validation)
//     if (!recipeData.name || !recipeData.ingredients) {
//       return res.status(400).json({ 
//         success: false, 
//         message: "Recipe name and ingredients are required!" 
//       });
//     }

//     // ২. নতুন ফিল্ড ও টাইমস্ট্যাম্প যোগ করা
//     const newRecipe = {
//       ...recipeData,
//       price: Number(recipeData.price) || 0, // 👈 'price' নাম্বারে কনভার্ট হবে
//       createdAt: new Date(),
//       status: "approved" // বা "pending" যদি অ্যাডমিন এপ্রুভাল লাগে
//     };

//     // ৩. MongoDB-তে সেভ করা
//     const result = await recipeCollection.insertOne(newRecipe);

//     res.status(201).json({
//       success: true,
//       message: "Recipe created successfully!",
//       insertedId: result.insertedId
//     });

//   } catch (error) {
//     console.error("Error creating recipe:", error);
//     res.status(500).json({ 
//       success: false, 
//       message: "Failed to create recipe", 
//       error: error.message 
//     });
//   }
// });



    




// // like and favitoe 

// // 1. Recipe Like Update API (PATCH /recipes/:id/like)
// app.patch('/recipes/:id/like', async (req, res) => {
//   const { id } = req.params;
//   const { userId, isLiked } = req.body;

//   try {
//     const query = { _id: new ObjectId(id) };
//     const update = isLiked
//       ? { $addToSet: { likedBy: userId }, $inc: { likesCount: 1 } }
//       : { $pull: { likedBy: userId }, $inc: { likesCount: -1 } };

//     const result = await db.collection('recipes').updateOne(query, update);
//     res.send({ success: true, result });
//   } catch (error) {
//     res.status(500).send({ success: false, message: error.message });
//   }
// });

// // 2. Add/Remove Favorite API (POST /users/favorites)
// app.post('/users/favorites', async (req, res) => {
//   const { userId, recipeId, isFavorite } = req.body;

//   try {
//     if (isFavorite) {
//       // Favorites কালেকশনে যোগ বা আপডেট করা
//       await db.collection('favorites').updateOne(
//         { userId, recipeId },
//         { $set: { userId, recipeId, createdAt: new Date() } },
//         { upsert: true }
//       );
//       // Recipe document-এ favoritedBy array আপডেট করা
//       await db.collection('recipes').updateOne(
//         { _id: new ObjectId(recipeId) },
//         { $addToSet: { favoritedBy: userId } }
//       );
//     } else {
//       await db.collection('favorites').deleteOne({ userId, recipeId });
//       await db.collection('recipes').updateOne(
//         { _id: new ObjectId(recipeId) },
//         { $pull: { favoritedBy: userId } }
//       );
//     }
//     res.send({ success: true });
//   } catch (error) {
//     res.status(500).send({ success: false, message: error.message });
//   }
// });





// // favoite add delted  


// // GET Favorites list for logged-in user
// app.get('/api/recipes/favorites', async (req, res) => {
//   try {
//     const { userId, userEmail } = req.query;

//     if (!userId && !userEmail) {
//       return res.status(400).json({ success: false, message: "User identity required" });
//     }

//     // ১. favorites কালেকশন থেকে ডাটা ফিল্টার
//     const filterConditions = [];
//     if (userId) filterConditions.push({ userId: userId });
//     if (userEmail) filterConditions.push({ userEmail: userEmail });

//     const userFavorites = await db.collection('favorites').find({
//       $or: filterConditions
//     }).toArray();

//     // ২. প্রতিটি favorite-এর জন্য মূল recipe তথ্য নিয়ে আসা
//     const populatedFavorites = await Promise.all(
//       userFavorites.map(async (fav) => {
//         let recipe = null;
//         if (fav.recipeId) {
//           try {
//             recipe = await db.collection('recipes').findOne({
//               _id: new ObjectId(fav.recipeId)
//             });
//           } catch (e) {
//             recipe = await db.collection('recipes').findOne({ _id: fav.recipeId });
//           }
//         }
//         return {
//           _id: fav._id,
//           userId: fav.userId,
//           recipe: recipe || fav.recipe || null
//         };
//       })
//     );

//     // null recipeগুলো বাদ দিয়ে পাঠানো
//     const validFavorites = populatedFavorites.filter(item => item.recipe !== null);

//     res.status(200).json({ success: true, favorites: validFavorites });
//   } catch (error) {
//     console.error("Fetch favorites error:", error);
//     res.status(500).json({ success: false, message: error.message });
//   }
// });

// // DELETE Favorite recipe
// app.delete('/api/recipes/favorites', async (req, res) => {
//   try {
//     const { favoriteId } = req.body;
//     let query = {};

//     if (ObjectId.isValid(favoriteId)) {
//       query = { _id: new ObjectId(favoriteId) };
//     } else {
//       query = { _id: favoriteId };
//     }

//     const result = await db.collection('favorites').deleteOne(query);

//     if (result.deletedCount > 0) {
//       return res.status(200).json({ success: true, message: "Removed successfully" });
//     } else {
//       return res.status(404).json({ success: false, message: "Item not found" });
//     }
//   } catch (error) {
//     res.status(500).json({ success: false, message: error.message });
//   }
// });








// // poulaer api

// // টপ ৩টি মোস্ট লাইকড রেসিপি পাওয়ার API
// app.get('/api/popular-recipes', async (req, res) => {
//   try {
//     const db = client.db('recipehouse');
    
//     // likesCount ফিল্ড অনুযায়ীDescending order-এ সর্ট করে প্রথম ৩টি নেওয়া
//     const popularRecipes = await db.collection('recipes')
//       .find({})
//       .sort({ likesCount: -1 }) // আপনার স্কিমা অনুযায়ী likesCount/likeCount সামঞ্জস্য রাখুন
//       .limit(3)
//       .toArray();

//     res.status(200).json({ success: true, recipes: popularRecipes });
//   } catch (error) {
//     console.error('Error fetching popular recipes:', error);
//     res.status(500).json({ success: false, message: 'Failed to fetch popular recipes' });
//   }
// });
    

    
   
//   //  get aip







// //   app.get('/recipes', async (req, res) => {
// //   try {
// //     // Query Parameter থেকে page, limit এবং search এর মান নেওয়া
// //     const page = parseInt(req.query.page) || 1;
// //     const limit = parseInt(req.query.limit) || 10;
// //     const search = req.query.search || '';
// //     const skip = (page - 1) * limit;

// //     // Search Query Filter তৈরি
// //     let query = {};
// //     if (search.trim() !== '') {
// //       // name ফিল্ডের ওপর কেস-ইনসেনসিটিভ সার্চ করা হবে (নামে মিল পেলেই ডাটা রিটার্ন করবে)
// //       query.name = { $regex: search.trim(), $options: 'i' };
// //     }

// //     // ১. ফিল্টার ও পেজিনেশন অনুযায়ী ডাটা আনা
// //     const recipes = await recipeCollection
// //       .find(query)
// //       .skip(skip)
// //       .limit(limit)
// //       .toArray();

// //     // ২. ফিল্টার করা কুয়েরির ওপর ভিত্তি করে মোট ডাটার সংখ্যা বের করা
// //     const totalCount = await recipeCollection.countDocuments(query);

// //     // ৩. মোট কতটি পেজ হবে তা হিসেব করা
// //     const totalPages = Math.ceil(totalCount / limit);

// //     // ফ্রন্টএন্ডে অবজেক্ট আকারে রেসপন্স পাঠানো
// //     res.status(200).json({
// //       success: true,
// //       recipes,
// //       totalPages,
// //       totalCount,
// //       currentPage: page,
// //     });
// //   } catch (error) {
// //     console.error('Error fetching recipes:', error);
// //     res.status(500).json({ success: false, message: 'Server error' });
// //   }
// // });

// // ok code 
// app.get('/recipes', async (req, res) => {
//   try {
//     // Query Parameter থেকে page এবং limit এর মান নেওয়া (Default: Page 1, Limit 10)
//     const page = parseInt(req.query.page) || 1;
//     const limit = parseInt(req.query.limit) || 10;
//     const skip = (page - 1) * limit;

//     // ১. নির্দিষ্ট পেজের ১০টি ডাটা আনা
//     const recipes = await recipeCollection
//       .find()
//       .skip(skip)
//       .limit(limit)
//       .toArray();

//     // ২. মোট রেসিপির সংখ্যা বের করা
//     const totalCount = await recipeCollection.countDocuments();

//     // ৩. মোট কতটি পেজ হবে তা হিসেব করা
//     const totalPages = Math.ceil(totalCount / limit);

//     // ফ্রন্টএন্ডে অবজেক্ট আকারে রেসপন্স পাঠানো
//     res.status(200).json({
//       success: true,
//       recipes,
//       totalPages,
//       totalCount,
//       currentPage: page,
//     });
//   } catch (error) {
//     console.error('Error fetching recipes:', error);
//     res.status(500).json({ success: false, message: 'Server error' });
//   }
// });


//   // ok code 
//   // app.get('/recipes', async (req, res) => {

//   //   const result = await recipeCollection.find().toArray();
//   //   res.send(result);
    


//   // })



//   // admin statas


// // app.get('/admin/stats', async (req, res) => {
// //   try {
// //     // collection name চেক করে নিন (যেমন: usersCollection / recipesCollection)
// //     const totalUsers = await usersCollection.countDocuments();
// //     const totalRecipes = await recipesCollection.countDocuments();
// //     const premiumMembers = await usersCollection.countDocuments({ role: 'pro' }); // অথবা { isPremium: true }
// //     const totalReports = 0; 

// //     res.status(200).send({
// //       success: true,
// //       totalUsers,
// //       totalRecipes,
// //       premiumMembers,
// //       totalReports
// //     });
// //   } catch (error) {
// //     console.error("Admin Stats Fetch Error:", error);
// //     res.status(500).send({ success: false, message: error.message });
// //   }
// // });





//   // my recipe
//   app.get('/myrecipes', async (req, res) => {


   

//     const result = await recipeCollection.find().toArray();

//     res.send(result);
    


//   })
//   // app.get('/myrecipes', async (req, res) => {


//   //   const limet = 10;
//   //   const currentPage=1
//   //   const skip= (currentPage-1)*limet

//   //   const result = await recipeCollection.find().toArray();

//   //   res.send({skip,limet,currentPage,result});
    


//   // })




//   // report code 


// // ১. রিপোর্ট জমা নেওয়ার API (POST /api/reports)
// app.post('/api/reports', async (req, res) => {
//   try {
//     const { recipeId, recipeTitle, reportedByEmail, userId, reason } = req.body;

//     if (!recipeId || !reason) {
//       return res.status(400).json({ success: false, message: 'Missing required fields' });
//     }

//     const db = client.db('recipehouse');
    
//     const newReport = {
//       recipeId: String(recipeId), // Safe string conversion
//       recipeTitle: recipeTitle || 'Untitled Recipe',
//       reportedByEmail: reportedByEmail || 'Anonymous',
//       userId: userId || null,
//       reason,
//       createdAt: new Date(),
//     };

//     const result = await db.collection('reports').insertOne(newReport);
//     res.status(201).json({ success: true, message: 'Report submitted successfully', insertedId: result.insertedId });
//   } catch (error) {
//     console.error('Report submission error:', error);
//     res.status(500).json({ success: false, message: 'Internal server error' });
//   }
// });

// // ২. এডমিন প্যানেলের জন্য সব রিপোর্ট পাওয়ার API (GET /api/admin/reports)
// app.get('/api/admin/reports', async (req, res) => {
//   try {
//     const db = client.db('recipehouse');
//     const reports = await db.collection('reports').find({}).sort({ createdAt: -1 }).toArray();

//     res.status(200).json({ success: true, reports });
//   } catch (error) {
//     console.error('Error fetching reports:', error);
//     res.status(500).json({ success: false, message: 'Failed to fetch reports' });
//   }
// });

// // ৩. রিপোর্ট ডিসমিস অথবা রেসিপি ডিলিট করার API (DELETE /api/admin/reports)
// app.delete('/api/admin/reports', async (req, res) => {
//   try {
//     const { reportId, recipeId, action } = req.body;
//     const db = client.db('recipehouse');

//     if (action === 'remove_recipe') {
//       // ১. রেসিপি ডিলিট (ObjectId দিয়ে)
//       if (recipeId && ObjectId.isValid(recipeId)) {
//         await db.collection('recipes').deleteOne({ _id: new ObjectId(recipeId) });
//       }

//       // ২. ওই রেসিপির সাথে সম্পর্কিত সব রিপোর্ট মুছে ফেলা (String recipeId দিয়ে)
//       if (recipeId) {
//         await db.collection('reports').deleteMany({ recipeId: String(recipeId) });
//       }
//     } else {
//       // ৩. শুধুমাত্র নির্দিষ্ট রিপোর্টটি Dismiss করা
//       if (reportId && ObjectId.isValid(reportId)) {
//         await db.collection('reports').deleteOne({ _id: new ObjectId(reportId) });
//       } else {
//         return res.status(400).json({ success: false, message: 'Invalid reportId format' });
//       }
//     }

//     res.status(200).json({ success: true, message: 'Action completed successfully' });
//   } catch (error) {
//     console.error('Report action error:', error);
//     res.status(500).json({ success: false, message: 'Action failed' });
//   }
// });






//   app.get("/recipes/:id", async (req, res) => {
//     const {id} = req.params
//     const result = await recipeCollection.findOne({ _id: new ObjectId(id) });
    
//     res.send(result);
//   });
   
   
//     app.get('/', (req, res) => {
//       res.send('RecipeHouse Server is Running!');
//     });

//   } catch (error) {
//     console.error("MongoDB Connection Error:", error);
//   }
// }

// run().catch(console.dir);

// app.listen(port, () => {
//   console.log(`🚀 Server listening on port ${port}`);
// });












// new addd 


// export default app;

// if (process.env.NODE_ENV !== "production") {
//   app.listen(port, () => {
//     console.log(`🚀 Server running on port ${port}`);
//   });
// }




















// require('dotenv').config();
// const express = require('express');
// const cors = require('cors');
// const { MongoClient, ServerApiVersion } = require('mongodb');
// const { betterAuth } = require('better-auth');
// const { mongodbAdapter } = require('better-auth/adapters/mongodb');
// const { toNodeHandler } = require('better-auth/node');
// const { jwt } = require('better-auth/plugins');

// const app = express();
// const port = process.env.PORT || 5000;

// app.use(
//   cors({
//     origin: [process.env.CLIENT_URL, "http://localhost:3000"],
//     credentials: true,
//   })
// );

// const uri = process.env.MONGODB_URI;

// if (!uri) {
//   console.error("❌ MONGODB_URI is not defined in .env file!");
//   process.exit(1);
// }

// const client = new MongoClient(uri, {
//   serverApi: {
//     version: ServerApiVersion.v1,
//     strict: true,
//     deprecationErrors: true,
//   }
// });

// async function run() {

//   try {
//     await client.connect();
//     const db = client.db("recipehouse");
//     const subscriptionCollection = db.collection("subscriptions");
//     const userCollection = db.collection("user");

  

//     console.log("✅ MongoDB Connected Successfully!");

//     const auth = betterAuth({
//       database: mongodbAdapter(db, {
//         client: client,
//       }),
//       emailAndPassword: {
//         enabled: true,
//       },

//       socialProviders: {
//         google: { 
//           clientId: process.env.GOOGLE_CLIENT_ID,
//           clientSecret: process.env.GOOGLE_CLIENT_SECRET,
//         },
//       },

//       // 🎯 ব্যাকএন্ড স্কিমায় role এবং plan ফিল্ড ২টা যুক্ত করা হলো
//       user: {
//         additionalFields: {
//           role: {
//             type: "string",
//             required: false,
//             defaultValue: "user",
//             input: true, // 👈 ক্লায়েন্ট থেকে ডাটা অ্যাকসেপ্ট করার অনুমতি
//           },
//           plan: {
//             type: "string",
//             required: false,
//             defaultValue: "free",
//             input: true, // 👈 ক্লায়েন্ট থেকে ডাটা অ্যাকসেপ্ট করার অনুমতি
//           },
//           image: {
//             type: "string",
//             required: false,
//             input: true,
//           },
//           isPremium: {
//             type: "boolean",
//             required: false,
//             defaultValue: false,
//           },
//           totalRecipes: {
//             type: "number",
//             required: false,
//             defaultValue: 0,
//           },
//           totalFavorites: {
//             type: "number",
//             required: false,
//             defaultValue: 0,
//           },
//           totalLikesReceived: {
//             type: "number",
//             required: false,
//             defaultValue: 0,
//           },
//         },
//       },

//       session: {
//         cookieCache: {
//           enabled: true,
//           strategy: "jwt",
//           maxAge: 60 * 60 * 24 * 7, // 7 Days
//         },
//       },

//       plugins: [jwt()],

//       secret: process.env.BETTER_AUTH_SECRET || "super-secret-key-12345",
//       baseURL: `http://localhost:${port}`,
//       trustedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
//     });

//     app.all("/api/auth/*splat", toNodeHandler(auth));
    
//     app.use(express.json());


   

//     app.get('/', (req, res) => {
//       res.send('RecipeHouse Server is Running!');
//     });

//   } catch (error) {
//     console.error("MongoDB Connection Error:", error);
//   }
// }

// run().catch(console.dir);

// app.listen(port, () => {
//   console.log(`🚀 Server listening on port ${port}`);
// });














// require('dotenv').config();
// const express = require('express');
// const cors = require('cors');
// const { MongoClient, ServerApiVersion } = require('mongodb');
// const { betterAuth } = require('better-auth');
// const { mongodbAdapter } = require('better-auth/adapters/mongodb');
// const { toNodeHandler } = require('better-auth/node');
// const { jwt } = require('better-auth/plugins'); // 💡 JWT plugin import

// const app = express();
// const port = process.env.PORT || 5000;

// app.use(
//   cors({
//     origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
//     credentials: true,
//   })
// );

// const uri = process.env.MONGODB_URI;

// if (!uri) {
//   console.error("❌ MONGODB_URI is not defined in .env file!");
//   process.exit(1);
// }

// const client = new MongoClient(uri, {
//   serverApi: {
//     version: ServerApiVersion.v1,
//     strict: true,
//     deprecationErrors: true,
//   }
// });

// async function run() {
//   try {
//     await client.connect();
//     const db = client.db("recipehouse");
//     console.log("✅ MongoDB Connected Successfully!");

//     const auth = betterAuth({
//       database: mongodbAdapter(db, {
//         client: client,
//       }),
//       emailAndPassword: {
//         enabled: true,
//       },

//       // 💡 ১. Google Social Provider যুক্ত করা হলো (যা মিসিং ছিল)
//       socialProviders: {
//         google: { 
//           clientId: process.env.GOOGLE_CLIENT_ID,
//           clientSecret: process.env.GOOGLE_CLIENT_SECRET,
//         },
//       },

//       // 💡 ২. Dashboard & Schema level Fields
//       user: {
//         additionalFields: {
//           image: {
//             type: "string",
//             required: false,
//             input: true,
//           },
//           isPremium: {
//             type: "boolean",
//             required: false,
//             defaultValue: false,
//           },
//           totalRecipes: {
//             type: "number",
//             required: false,
//             defaultValue: 0,
//           },
//           totalFavorites: {
//             type: "number",
//             required: false,
//             defaultValue: 0,
//           },
//           totalLikesReceived: {
//             type: "number",
//             required: false,
//             defaultValue: 0,
//           },
//         },
//       },

//       // 💡 ৩. Session & Cookie Cache Setup
//       session: {
//         cookieCache: {
//           enabled: true,
//           strategy: "jwt",
//           maxAge: 60 * 60 * 24 * 7, // 7 Days
//         },
//       },

//       // 💡 ৪. JWT Plugin
//       plugins: [jwt()],

//       secret: process.env.BETTER_AUTH_SECRET || "super-secret-key-12345",
//       baseURL: `http://localhost:${port}`,
//       trustedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
//     });

//     // Better Auth Handler
//     // app.all("/api/auth/*", toNodeHandler(auth)); // 💡 app.use-এর বদলে app.all("/api/auth/*") দেয়া নিরাপদ

//     app.all("/api/auth/*splat", toNodeHandler(auth));
//     // Global Body Parser
//     app.use(express.json());

//     app.get('/', (req, res) => {
//       res.send('RecipeHouse Server is Running!');
//     });

//   } catch (error) {
//     console.error("MongoDB Connection Error:", error);
//   }
// }

// run().catch(console.dir);

// app.listen(port, () => {
//   console.log(`🚀 Server listening on port ${port}`);
// });


// require('dotenv').config();
// const express = require('express');
// const cors = require('cors');
// const { MongoClient, ServerApiVersion } = require('mongodb');
// const { betterAuth } = require('better-auth');
// const { mongodbAdapter } = require('better-auth/adapters/mongodb');
// const { toNodeHandler } = require('better-auth/node');

// const app = express();
// const port = process.env.PORT || 5000;

// app.use(
//   cors({
//     origin: ["http://localhost:3000", "http://127.0.0.1:3000"],
//     credentials: true,
//   })
// );

// const uri = process.env.MONGODB_URI;

// if (!uri) {
//   console.error("❌ MONGODB_URI is not defined in .env file!");
//   process.exit(1);
// }

// const client = new MongoClient(uri, {
//   serverApi: {
//     version: ServerApiVersion.v1,
//     strict: true,
//     deprecationErrors: true,
//   }
// });

// async function run() {
//   try {
//     await client.connect();
//     const db = client.db("recipehouse");
//     console.log("✅ MongoDB Connected Successfully!");

//     const auth = betterAuth({
//       database: mongodbAdapter(db),
//       emailAndPassword: {
//         enabled: true,
//       },
//       secret: process.env.BETTER_AUTH_SECRET || "super-secret-key-12345",
//       baseURL: `http://localhost:${port}`,
      
//       // 💡 এটি যোগ করা হয়েছে: ফ্রন্টএন্ড Origin কে ট্রাস্ট করার জন্য
//       trustedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
//     });

//     // 💡 Better Auth Handler
//     app.use("/api/auth", toNodeHandler(auth));

//     // Global Body Parser
//     app.use(express.json());

//     app.get('/', (req, res) => {
//       res.send('RecipeHouse Server is Running!');
//     });

//   } catch (error) {
//     console.error("MongoDB Connection Error:", error);
//   }
// }

// run().catch(console.dir);

// app.listen(port, () => {
//   console.log(`🚀 Server listening on port ${port}`);
// });












// // require('dotenv').config(); // 1. dotenv কনফিগার করা হলো (একদম উপরে থাকতে হবে)
// // const express = require('express');
// // const cors = require('cors'); // CORS ব্যবহার করা ভালো
// // const { MongoClient, ServerApiVersion } = require('mongodb');

// // const app = express();
// // const port = process.env.PORT || 5000;

// // // Middleware
// // app.use(cors());
// // app.use(express.json());

// // const uri = process.env.MONGODB_URI;

// // // URI সঠিকভাবে লোড হচ্ছে কি না চেক করার জন্য
// // if (!uri) {
// //   console.error("❌ MONGODB_URI is not defined in .env file!");
// //   process.exit(1);
// // }

// // const client = new MongoClient(uri, {
// //   serverApi: {
// //     version: ServerApiVersion.v1,
// //     strict: true,
// //     deprecationErrors: true,
// //   }
// // });

// // let db; // 2. db ভ্যারিয়েবল ডিক্লেয়ার করা হলো

// // async function run() {
// //   try {
// //     // MongoDB ক্লায়েন্ট কানেক্ট করা
// //     await client.connect();
// //     db = client.db("recipehouse");
    
// //     // কালেকশনগুলো এখানে সেট করতে পারেন
// //     // const recipeCollection = db.collection("recipes");
    
// //     console.log("✅ MongoDB Connected Successfully!");

// //     // রুটের ভেতরের কোড বা API Endpoint
// //     app.get('/', (req, res) => {
// //       res.send('RecipeHouse Server is Running!');
// //     });

// //   } catch (error) {
// //     console.error("MongoDB Connection Error:", error);
// //   }
// // }

// // // কানেকশন রান করা
// // run().catch(console.dir);

// // app.listen(port, () => {
// //   console.log(`🚀 Server listening on port ${port}`);
// // });











// // const express = require('express');
// // const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
// // const app = express();
// // const port = 5000;

// // const { MongoClient, ServerApiVersion } = require('mongodb');
// // const uri = process.env.MONGODB_URI;

// // const client = new MongoClient(uri, {
// //   serverApi: {
// //     version: ServerApiVersion.v1,
// //     strict: true,
// //     deprecationErrors: true,
// //   }
// // });


// // // let db, carCollection, mybookingsCollection;

// // async function connectDB() {
// //   if (!db) {
// //     await client.connect();
// //     db = client.db("recipehouse");
// //     // carCollection = db.collection("cars");
// //     // mybookingsCollection = db.collection("my-bookings");
// //     console.log("MongoDB Connected Successfully!");
// //   }
// // }

// // app.get('/', (req, res) => {
// //   res.send('Hello World!');
// // });

// // app.listen(port, () => {
// //   console.log(`Example app listening on port ${port}`);
// // });