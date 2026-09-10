require('dotenv').config();
const express = require('express');
const Stripe = require('stripe');
const { createClient } = require('@supabase/supabase-js');
const { clerkMiddleware, getAuth } = require('@clerk/express');

const app = express();
const stripe = Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_SERVICE_ROLE_KEY);

// 1. Подключаем middleware Clerk для обработки сессий авторизации
app.use(clerkMiddleware());

// 2. Webhook Stripe должен получать RAW body (сырые данные), а не обработанный JSON!
app.post('/api/webhook', express.raw({ type: 'application/json' }), async (req, res) => {
    const sig = req.headers['stripe-signature'];
    let event;

    try {
        event = stripe.webhooks.constructEvent(req.body, sig, process.env.STRIPE_WEBHOOK_SECRET);
    } catch (err) {
        console.error('Ошибка Webhook:', err.message);
        return res.status(400).send(`Webhook Error: ${err.message}`);
    }

    // Обработка успешной оплаты подписки
    if (event.type === 'checkout.session.completed') {
        const session = event.data.object;
        const userId = session.metadata.userId; // Читаем ID пользователя из Clerk

        // Обновляем статус подписки в Supabase
        const { error } = await supabase
            .from('users')
            .update({ subscription_status: 'pro' })
            .eq('id', userId);

        if (error) console.error('Ошибка обновления базы:', error);
    }

    res.json({ received: true });
});

// 3. Middleware для парсинга JSON для всех остальных роутов
app.use(express.json());

// 4. Маршрут для создания сессии оплаты Stripe
app.post('/api/create-checkout-session', async (req, res) => {
    const { userId } = getAuth(req);

    if (!userId) {
        return res.status(401).json({ error: 'Необходима авторизация через Clerk' });
    }

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            mode: 'subscription',
            line_items: [
                {
                    price: process.env.STRIPE_PRICE_ID,
                    quantity: 1,
                },
            ],
            metadata: {
                userId: userId, // Передаем ID пользователя из Clerk в метаданные Stripe
            },
            success_url: `${process.env.CLIENT_URL}/success`,
            cancel_url: `${process.env.CLIENT_URL}/cancel`,
        });

        res.json({ url: session.url });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`Сервер запущен на порту ${PORT}`));