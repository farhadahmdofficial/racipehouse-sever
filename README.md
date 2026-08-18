

# 🍳 RecipeHub — Server API

The backend API service for **RecipeHub**, a full-stack recipe sharing platform. Built with Node.js, Express.js, MongoDB, JWT/JWKS authentication, and Stripe payment handling.

---

## 🌐 Related Links

- **Client Repository:** [Insert Client Github Link Here]
- **Live Server URL:** [Insert Server Deployment Link Here]

---

## 🛠️ Tech Stack & Dependencies

- **Runtime:** Node.js
- **Framework:** Express.js
- **Database:** MongoDB
- **Authentication:** JWT, JOSE (JWKS verification)
- **Payments:** Stripe API (`stripe`)
- **HTTP/Cors:** `cors`, `axios`
- **Environment Management:** `dotenv`

---

## 🔑 Key Features & API Responsibilities

### 🔐 Authentication & Authorization
- **JWT Verification Middleware:** Validates incoming requests using Bearer tokens and JWKS verification.
- **Role-Based Access Control:** Protects Admin-only endpoints (Users management, Recipe moderation, Reports handling).

### 📖 Recipe Management (`/recipes`)
- **Add Recipe:** Enforces the limit of **maximum 2 recipes** for normal users. Unlocks unlimited recipe creation for premium members.
- **Browse & Filter:** Supports server-side pagination and category filtering using MongoDB `$in` operator.
- **CRUD Operations:** Fetch, update, delete, and toggle `isFeatured` status.

### 👤 User & Admin Management (`/api/admin`)
- **System Metrics:** Aggregates totals for Users, Recipes, Premium Members, and Reports for the Admin Overview dashboard.
- **User Moderation:** Fetch all registered users, block, or unblock user accounts.
- **Report System:** Process user-submitted recipe flags (Spam, Offensive, Copyright) and allows dismissal or content removal.

### 💳 Stripe Payments (`/payments`)
- **Stripe Checkout Sessions:** Handles premium membership upgrades and individual recipe purchases.
- **Transaction Records:** Logs successful transactions in the `payments` collection.

---

## 🗄️ Database Collections Structure

- **`users`**: User identity, role (`admin` | `user`), block status (`isBlocked`), and premium status (`isPremium`).
- **`recipes`**: Recipe details, category, cuisine, ingredients, instructions, author metadata, likes, and featured status.
- **`favorites`**: User saved recipes mapping (`userId`, `recipeId`).
- **`reports`**: User flags with report reasons (`Spam`, `Offensive Content`, `Copyright Issue`).
- **`payments`**: Payment history, transaction ID, payment status, and timestamps.

---

## 🚀 Environment Setup & Local Installation

### Prerequisites
- Node.js (v18+)
- MongoDB Atlas Database URI
- Stripe Secret Key

### 1. Installation

```bash
git clone [https://github.com/your-username/recipehouse-server.git](https://github.com/your-username/recipehouse-server.git)
cd recipehouse-server
npm install

