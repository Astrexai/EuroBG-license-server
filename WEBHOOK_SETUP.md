# 🔐 License Server Webhook Setup

## ✅ Complete Webhook Flow

Your server is now configured with a complete Stripe → Supabase → Shopify integration.

### 📋 Webhook Process

When a customer completes payment on Stripe:

1. **Stripe sends webhook** → `POST /webhook`
2. **Verify signature** → Ensures request is from Stripe
3. **Generate license key** → UUID format
4. **Save to Supabase** → `licenses` table with email
5. **Update Shopify order** → Add license key to order note

### 🛠️ Required Environment Variables

```env
# Supabase
SUPABASE_URL=https://fjehkspazhawhqbgpmtw.supabase.co
SUPABASE_SERVICE_ROLE_KEY=your_service_role_key

# Stripe
STRIPE_SECRET_KEY=sk_test_...
STRIPE_WEBHOOK_SECRET=whsec_...

# Shopify
SHOPIFY_STORE=euro-bg-2.myshopify.com
SHOPIFY_ACCESS_TOKEN=shpss_...
```

### 📊 Supabase Table Schema

Your `licenses` table should have:

| Column | Type | Notes |
|--------|------|-------|
| id | UUID | Primary key |
| email | text | Customer email |
| key | text | License key (UUID) |
| active | boolean | Default: true |
| created_at | timestamp | Creation date |

### 🔄 How to Pass Order ID to Webhook

When creating a Stripe checkout session, include Shopify Order ID in metadata:

```javascript
const session = await stripe.checkout.sessions.create({
  payment_method_types: ['card'],
  line_items: [...],
  mode: 'payment',
  customer_email: customer.email,
  metadata: {
    shopify_order_id: order.id,  // 🔑 This is crucial!
  },
  success_url: 'https://yourdomain.com/success',
  cancel_url: 'https://yourdomain.com/cancel',
});
```

### 📝 Webhook Endpoints

**POST /webhook**
- Listens for Stripe events
- Handles: `checkout.session.completed`
- Automatically creates license and updates Shopify order

### ✅ Available Endpoints

- `GET /` - Health check
- `POST /generate` - Generate new licenses (bulk)
- `POST /activate` - Activate a license
- `POST /verify` - Verify license validity
- `POST /webhook` - Stripe webhook handler

### 🚀 Start Server

```bash
npm start
```

Server runs on `http://localhost:3000`

### 🔍 Logs

Check console for:
- ✅ License generated
- 📝 License added to Shopify order
- ❌ Any errors during process

---

**Version:** 1.0
**Last Updated:** 2025-12-10
