import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";
import path from "path";
import { fileURLToPath } from "url";

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config();

const supabase = createClient(
  process.env.SUPABASE_URL,
  process.env.SUPABASE_SERVICE_ROLE_KEY
);

const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const endpointSecret = process.env.STRIPE_WEBHOOK_SECRET;

const app = express();

// Helper function to attach license to Shopify order
async function attachLicenseToShopifyOrder(orderId, licenseKey) {
  const shop = process.env.SHOPIFY_STORE;
  const token = process.env.SHOPIFY_ACCESS_TOKEN;

  if (!shop || !token) {
    console.log('⚠️ Shopify credentials missing, skipping order update');
    return;
  }

  const url = `https://${shop}/admin/api/2024-01/orders/${orderId}.json`;

  try {
    await axios.put(
      url,
      {
        order: {
          id: orderId,
          note: `Лицензен ключ: ${licenseKey}`,
        },
      },
      {
        headers: {
          'X-Shopify-Access-Token': token,
          'Content-Type': 'application/json',
        },
      }
    );

    console.log(`✅ Лицензният ключ е добавен към Shopify order ${orderId}`);
  } catch (err) {
    console.error('❌ Грешка при добавяне на лиценз към Shopify поръчка:', err.response?.data || err.message);
  }
}

// Stripe webhook endpoint - must be BEFORE express.json() middleware
app.post('/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
  const sig = req.headers['stripe-signature'];

  let event;
  try {
    event = stripe.webhooks.constructEvent(req.body, sig, endpointSecret);
  } catch (err) {
    console.error('❌ Webhook error:', err.message);
    return res.status(400).send(`Webhook Error: ${err.message}`);
  }

  // 🎯 Stripe плащане е успешно
  if (event.type === 'checkout.session.completed') {
    const session = event.data.object;

    const email = session.customer_email || session.customer_details?.email;
    const licenseKey = uuidv4(); // Генерираме уникален лиценз
    const orderId = session.metadata?.shopify_order_id; // ако го подадеш през metadata

    // 🧾 Запиши в Supabase
    const { error } = await supabase.from('licenses').insert([
      {
        email,
        key: licenseKey,
        active: true,
        created_at: new Date().toISOString()
      },
    ]);

    if (error) {
      console.error('❌ Supabase insert error:', error.message);
      return res.status(500).send('Supabase error');
    }

    console.log(`✅ Лиценз за ${email}: ${licenseKey}`);

    // 🛍️ Добави лиценза към Shopify поръчка (ако има)
    if (orderId) {
      try {
        const shopifyUrl = `https://${process.env.SHOPIFY_STORE}/admin/api/2024-01/orders/${orderId}.json`;

        await axios.put(
          shopifyUrl,
          {
            order: {
              id: orderId,
              note: `Лицензен ключ: ${licenseKey}`,
            },
          },
          {
            headers: {
              'X-Shopify-Access-Token': process.env.SHOPIFY_ACCESS_TOKEN,
              'Content-Type': 'application/json',
            },
          }
        );

        console.log(`📝 Лицензът е добавен към Shopify order ${orderId}`);
      } catch (shopifyErr) {
        console.error('❌ Shopify error:', shopifyErr.response?.data || shopifyErr.message);
      }
    } else {
      console.log('⚠️ No Shopify order ID found in metadata');
    }

    return res.status(200).send('Webhook received');
  }

  res.status(200).send('OK');
});

// Serve static files (including success.html)
app.use(express.static(__dirname));

app.use(express.json());

// Helper function to generate license key
function generateLicenseKey() {
  return crypto.randomBytes(16).toString("hex");
}

// GET root route
app.get("/", (req, res) => {
  res.send("EuroBG License Server is running.");
});

// Generate licenses
app.post("/generate", async (req, res) => {
  try {
    const { count, email } = req.body;
    let keys = [];

    for (let i = 0; i < count; i++) {
      const key = generateLicenseKey();
      keys.push(key);
    }

    const licensesToInsert = keys.map(key => ({
      key,
      email: email || null,
      active: false,
      created_at: new Date().toISOString()
    }));

    const { data, error } = await supabase
      .from('licenses')
      .insert(licensesToInsert);

    if (error) {
      return res.status(500).json({ error: error.message });
    }

    res.json({ keys, count: keys.length });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Activate license
app.post("/activate", async (req, res) => {
  try {
    const { key } = req.body;

    if (!key) {
      return res.status(400).json({ error: "License key is required" });
    }

    const { data, error: selectError } = await supabase
      .from('licenses')
      .select('*')
      .eq('key', key)
      .single();

    if (selectError || !data) {
      return res.status(404).json({ error: "Invalid license key" });
    }

    const { error: updateError } = await supabase
      .from('licenses')
      .update({ active: true, activated_at: new Date().toISOString() })
      .eq('key', key);

    if (updateError) {
      return res.status(500).json({ error: updateError.message });
    }

    res.json({ success: true, license: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Verify license
app.post("/verify", async (req, res) => {
  try {
    const { key } = req.body;

    if (!key) {
      return res.status(400).json({ error: "License key is required" });
    }

    const { data, error } = await supabase
      .from('licenses')
      .select('*')
      .eq('key', key)
      .single();

    if (error || !data) {
      return res.status(404).json({ valid: false });
    }

    res.json({ valid: true, active: data.active, license: data });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Get license by Stripe session ID
app.get("/get-license", async (req, res) => {
  const session_id = req.query.session_id;

  if (!session_id) {
    return res.status(400).json({ error: "Missing session_id" });
  }

  try {
    const session = await stripe.checkout.sessions.retrieve(session_id);
    const email = session.customer_email || session.customer_details?.email;

    const { data, error } = await supabase
      .from('licenses')
      .select('key')
      .eq('email', email)
      .order('created_at', { ascending: false })
      .limit(1)
      .single();

    if (error || !data) {
      return res.status(404).json({ error: 'License not found' });
    }

    res.json({ license: data.key });
  } catch (err) {
    console.error("Error fetching license:", err.message);
    res.status(500).json({ error: "Server error" });
  }
});

// Create Stripe Checkout Session
app.post("/create-checkout-session", async (req, res) => {
  try {
    const { shopify_order_id } = req.body;

    const session = await stripe.checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      line_items: [
        {
          price_data: {
            currency: 'bgn',
            product_data: {
              name: 'EuroBG – Онлайн + Офлайн софтуер',
              description: 'Пълен достъп до онлайн и офлайн версия на EuroBG',
            },
            unit_amount: 300, // 3.00 BGN (amount in cents)
          },
          quantity: 1,
        },
      ],
      metadata: {
        shopify_order_id: shopify_order_id || '' // Include Shopify order ID if provided
      },
      success_url: 'https://eurobg-license-server.onrender.com/success.html?session_id={CHECKOUT_SESSION_ID}',
      cancel_url: 'https://eurobg-license-server.onrender.com/cancel.html',
    });

    res.json({ url: session.url });
  } catch (err) {
    console.error("Error creating checkout session:", err.message);
    res.status(500).json({ error: "Failed to create checkout session" });
  }
});

// Shopify Webhook - Triggered when order is created/paid
app.post('/shopify-webhook', express.json(), async (req, res) => {
  try {
    const data = req.body;

    const email = data?.email;
    const orderId = data?.id;

    if (!email || !orderId) {
      console.log("⚠️ Няма имейл или ID в Shopify webhook");
      return res.status(400).send("Missing data");
    }

    const licenseKey = uuidv4(); // Генерирай лиценза

    // Запиши в Supabase
    const { error } = await supabase.from('licenses').insert([{
      email,
      key: licenseKey,
      active: true,
      created_at: new Date().toISOString(),
    }]);

    if (error) {
      console.error("❌ Supabase insert error:", error.message);
      return res.status(500).send("Supabase error");
    }

    console.log(`✅ Лиценз създаден за ${email}: ${licenseKey}`);

    // Добави лиценза като бележка в Shopify поръчката
    await attachLicenseToShopifyOrder(orderId, licenseKey);

    res.status(200).send("OK");
  } catch (err) {
    console.error("❌ Webhook processing error:", err.message);
    res.status(500).send("Internal error");
  }
});

app.listen(3000, () => console.log("License server running on :3000"));
