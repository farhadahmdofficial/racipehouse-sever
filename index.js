






require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { MongoClient, ServerApiVersion, ObjectId } = require('mongodb');
const { betterAuth } = require('better-auth');
const { mongodbAdapter } = require('better-auth/adapters/mongodb');
const { toNodeHandler } = require('better-auth/node');
const { jwt } = require('better-auth/plugins');
const Stripe = require('stripe');

// Stripe Initialize
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);

const app = express();
const port = process.env.PORT || 5000;

// 1. CORS Middleware
app.use(
  cors({
    origin: [process.env.CLIENT_URL, "http://localhost:3000"],
    credentials: true,
  })
);

// 2. Body Parser Middleware (অবশ্যই Route এবং Auth-এর আগে থাকতে হবে)
app.use(express.json());

const uri = process.env.MONGODB_URI;

if (!uri) {
  console.error("❌ MONGODB_URI is not defined in .env file!");
  process.exit(1);
}

const client = new MongoClient(uri, {
  serverApi: {
    version: ServerApiVersion.v1,
    strict: true,
    deprecationErrors: true,
  }
});

async function run() {
  try {
    await client.connect();
    const db = client.db("recipehouse");
    const subscriptionCollection = db.collection("subscriptions");
    const userCollection = db.collection("user");
    const recipeCollection = db.collection("recipes");

    console.log("✅ MongoDB Connected Successfully!");

    // Better Auth Setup
    const auth = betterAuth({
      database: mongodbAdapter(db, {
        client: client,
      }),
      emailAndPassword: {
        enabled: true,
      },
      socialProviders: {
        google: { 
          clientId: process.env.GOOGLE_CLIENT_ID,
          clientSecret: process.env.GOOGLE_CLIENT_SECRET,
        },
      },
      user: {
        additionalFields: {
          role: {
            type: "string",
            required: false,
            defaultValue: "user",
            input: true,
          },
          plan: {
            type: "string",
            required: false,
            defaultValue: "free",
            input: true,
          },
          image: {
            type: "string",
            required: false,
            input: true,
          },
          isPremium: {
            type: "boolean",
            required: false,
            defaultValue: false,
          },
          totalRecipes: {
            type: "number",
            required: false,
            defaultValue: 0,
          },
          totalFavorites: {
            type: "number",
            required: false,
            defaultValue: 0,
          },
          totalLikesReceived: {
            type: "number",
            required: false,
            defaultValue: 0,
          },
        },
      },
      session: {
        cookieCache: {
          enabled: true,
          strategy: "jwt",
          maxAge: 60 * 60 * 24 * 7, // 7 Days
        },
      },
      plugins: [jwt()],
      secret: process.env.BETTER_AUTH_SECRET || "super-secret-key-12345",
      baseURL: `http://localhost:${port}`,
      trustedOrigins: ["http://localhost:3000", "http://127.0.0.1:3000"],
    });

    // Better Auth Handler
    app.all("/api/auth/*splat", toNodeHandler(auth));





    // 🎯 Subscription & Plan Update Route

//     app.post("/subscription", async (req, res) => {
//   try {
//     const { user, session_id } = req.body;

//     // ১. প্রয়োজনীয় ডাটা আছে কিনা চেক
//     if (!user?.id || !session_id) {
//       return res.status(400).json({ 
//         success: false, 
//         message: "User ID and session_id are required!" 
//       });
//     }

//     // 🎯 ২. ডুপ্লিকেট চেক: এই session_id কি আগেই প্রসেস করা হয়েছে?
//     const existingSub = await subscriptionCollection.findOne({ session_id });

//     if (existingSub) {
//       // ডাটা আগেই যুক্ত হয়ে গেছে, তাই নতুন করে ইনসার্ট না করে সফল মেসেজ ফেরত দিন
//       return res.status(200).json({
//         success: true,
//         message: "Subscription already processed!",
//         alreadyProcessed: true,
//       });
//     }

//     // ৩. Stripe থেকে পেমেন্ট স্ট্যাটাস ভেরিফাই করা
//     const session = await stripe.checkout.sessions.retrieve(session_id);

//     if (session.payment_status !== "paid") {
//       return res.status(400).json({ 
//         success: false, 
//         message: "Payment has not been completed." 
//       });
//     }

//     // ৪. ObjectId সেফ কাস্টিং
//     let userObjectId;
//     try {
//       userObjectId = new ObjectId(user.id);
//     } catch (err) {
//       return res.status(400).json({ 
//         success: false, 
//         message: "Invalid User ID format." 
//       });
//     }

//     // ৫. Subscriptions কালেকশনে এন্ট্রি তৈরি (প্রথমবার হলে)
//     const sub_result = await subscriptionCollection.insertOne({
//       userId: userObjectId,
//       session_id,
//       amount: session.amount_total / 100,
//       currency: session.currency,
//       createdAt: new Date(),
//     });

//     // ৬. User কালেকশনে প্রিমিয়াম স্ট্যাটাস আপডেট
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

//     // ৭. সফল রেসপন্স
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





    app.post("/subscription", async (req, res) => {
  try {
    const { user, session_id } = req.body;

    // ১. প্রয়োজনীয় ডাটা আছে কিনা চেক
    if (!user?.id || !session_id) {
      return res.status(400).json({ 
        success: false, 
        message: "User ID and session_id are required!" 
      });
    }

    // ২. Stripe থেকে পেমেন্ট স্ট্যাটাস ভেরিফাই করা
    const session = await stripe.checkout.sessions.retrieve(session_id);

    if (session.payment_status !== "paid") {
      return res.status(400).json({ 
        success: false, 
        message: "Payment has not been completed." 
      });
    }

    // ৩. ObjectId সেফ কাস্টিং
    let userObjectId;
    try {
      userObjectId = new ObjectId(user.id);
    } catch (err) {
      return res.status(400).json({ 
        success: false, 
        message: "Invalid User ID format." 
      });
    }

    // ৪. Subscriptions কালেকশনে এন্ট্রি তৈরি
    const sub_result = await subscriptionCollection.insertOne({
      userId: userObjectId,
      session_id,
      amount: session.amount_total / 100,
      currency: session.currency,
      createdAt: new Date(),
    });

    // ৫. User কালেকশনে প্রিমিয়াম স্ট্যাটাস আপডেট
    const user_result = await userCollection.updateOne(
      { _id: userObjectId },
      { 
        $set: { 
          plan: "pro",
          isPremium: true,
          updatedAt: new Date()
        } 
      }
    );

    // ৬. সফল রেসপন্স
    return res.status(200).json({
      success: true,
      message: "Subscription verified and plan upgraded successfully!",
      sub_result,
      user_result,
    });

  } catch (error) {
    console.error("❌ Error in /subscription route:", error);
    return res.status(500).json({ 
      success: false, 
      message: "Internal Server Error", 
      error: error.message 
    });
  }
});












    // app.post("/subscription", async (req, res) => {
    //   const { user,session_id} = req.body;
    //   const sub_result = await subscriptionCollection.insertOne({ userId: new ObjectId(user.id), session_id });
    //   const user_result = await userCollection.updateOne({ _id: new ObjectId(user.id) }, { $set: { plan: "pro" } });


    //   res.send({ sub_result, user_result });

    // });





    // recipe post api 

    app.post("/recipes", async (req, res) => {
  try {
    const recipeData = req.body;

    // ১. প্রয়োজনীয় ফিল্ডগুলো চেক করা (Basic Validation)
    if (!recipeData.name || !recipeData.ingredients) {
      return res.status(400).json({ 
        success: false, 
        message: "Recipe name and ingredients are required!" 
      });
    }

    // ২. নতুন ফিল্ড ও টাইমস্ট্যাম্প যোগ করা
    const newRecipe = {
      ...recipeData,
      price: Number(recipeData.price) || 0, // 👈 'price' নাম্বারে কনভার্ট হবে
      createdAt: new Date(),
      status: "approved" // বা "pending" যদি অ্যাডমিন এপ্রুভাল লাগে
    };

    // ৩. MongoDB-তে সেভ করা
    const result = await recipeCollection.insertOne(newRecipe);

    res.status(201).json({
      success: true,
      message: "Recipe created successfully!",
      insertedId: result.insertedId
    });

  } catch (error) {
    console.error("Error creating recipe:", error);
    res.status(500).json({ 
      success: false, 
      message: "Failed to create recipe", 
      error: error.message 
    });
  }
});


    
// app.post("/recipes", async (req, res) => {
//   try {
//     const recipeData = req.body;

//     // ১. প্রয়োজনীয় ফিল্ডগুলো চেক করা (Basic Validation)
//     if (!recipeData.name || !recipeData.ingredients) {
//       return res.status(400).json({ 
//         success: false, 
//         message: "Recipe name and ingredients are required!" 
//       });
//     }

//     // ২. নতুন ফিল্ড ও টাইমস্ট্যাম্প যোগ করা
//     const newRecipe = {
//       ...recipeData,
//       createdAt: new Date(),
//       status: "approved" // বা "pending" যদি অ্যাডমিন এপ্রুভাল লাগে
//     };

//     // ৩. MongoDB-তে সেভ করা
//     // const result = await recipeCollection.insertOne({ ...newRecipe, Price: Number(recipeData?.Price) });

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







    

    // Root Endpoint
   
  //  get aip


  app.get('/recipes', async (req, res) => {

    const result = await recipeCollection.find().toArray();
    res.send(result);
    


  })


  app.get("/recipes/:id", async (req, res) => {
    const {id} = req.params
    const result = await recipeCollection.findOne({ _id: new ObjectId(id) });
    
    res.send(result);
  });
   
   
    app.get('/', (req, res) => {
      res.send('RecipeHouse Server is Running!');
    });

  } catch (error) {
    console.error("MongoDB Connection Error:", error);
  }
}

run().catch(console.dir);

app.listen(port, () => {
  console.log(`🚀 Server listening on port ${port}`);
});




















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