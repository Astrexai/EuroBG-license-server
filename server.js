import express from "express";
import crypto from "crypto";
import dotenv from "dotenv";
import { createClient } from "@supabase/supabase-js";
import Stripe from "stripe";
import { v4 as uuidv4 } from "uuid";
import axios from "axios";

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

    const email = session.customer_details.email;
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

app.listen(3000, () => console.log("License server running on :3000"));
