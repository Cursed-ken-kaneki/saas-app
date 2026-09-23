import express from 'express';
import cors from 'cors';
import dotenv from 'dotenv';
import Stripe from 'stripe';
import { createClient } from '@supabase/supabase-js';
import { clerkMiddleware } from '@clerk/express';

dotenv.config();

const app = express();
const port = process.env.PORT || 3000;

// Инициализация клиентов
const stripe = new Stripe(process.env.STRIPE_SECRET_KEY);
const supabase = createClient(
    process.env.SUPABASE_URL,
    process.env.SUPABASE_SERVICE_ROLE_KEY
);

// Middleware
app.use(cors());
app.use(express.static('public'));

// ВЕБХУК STRIPE (должен быть ДО express.json(), так как требует raw body)
app.post(
    '/api/webhook',
    express.raw({ type: 'application/json' }),
    async (req, res) => {
        const sig = req.headers['stripe-signature'];
        let event;

        try {
            event = stripe.webhooks.constructEvent(
                req.body,
                sig,
                process.env.STRIPE_WEBHOOK_SECRET
            );
        } catch (err) {
            console.error(`Webhook Error: ${err.message}`);
            return res.status(400).send(`Webhook Error: ${err.message}`);
        }

        if (event.type === 'checkout.session.completed') {
            const session = event.data.object;
            const userId = session.client_reference_id;

            // Обновляем статус подписки пользователя в Supabase
            if (userId) {
                const { error } = await supabase
                    .from('users')
                    .upsert({ id: userId, is_pro: true, stripe_customer_id: session.customer });

                if (error) {
                    console.error('Ошибка обновления базы данных:', error);
                } else {
                    console.log(`Пользователь ${userId} получил Pro-статус!`);
                }
            }
        }

        res.json({ received: true });
    }
);

// Парсинг JSON для всех остальных маршрутов
app.use(express.json());

// Clerk Middleware
app.use(
    clerkMiddleware({
        publishableKey: process.env.CLERK_PUBLISHABLE_KEY,
        secretKey: process.env.CLERK_SECRET_KEY,
    })
);

// --- ЭНДПОИНТЫ МЕССЕНДЖЕРА ---

// 1. Получить список всех комнат
app.get('/api/rooms', async (req, res) => {
    const { data, error } = await supabase
        .from('rooms')
        .select('*')
        .order('created_at', { ascending: false });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 2. Создать новую комнату
app.post('/api/rooms', async (req, res) => {
    const { name } = req.body;
    if (!name) return res.status(400).json({ error: 'Укажите название комнаты' });

    const { data, error } = await supabase
        .from('rooms')
        .insert([{ name }])
        .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data[0]);
});

// 3. Получить истории сообщений конкретной комнаты
app.get('/api/rooms/:roomId/messages', async (req, res) => {
    const { roomId } = req.params;
    const { data, error } = await supabase
        .from('messages')
        .select('*')
        .eq('room_id', roomId)
        .order('created_at', { ascending: true });

    if (error) return res.status(500).json({ error: error.message });
    res.json(data);
});

// 4. Отправить сообщение
app.post('/api/messages', async (req, res) => {
    const { roomId, userId, userName, text } = req.body;

    if (!roomId || !userId || !text) {
        return res.status(400).json({ error: 'Не заполнено одно из обязательных полей' });
    }

    const { data, error } = await supabase
        .from('messages')
        .insert([
            {
                room_id: roomId,
                user_id: userId,
                user_name: userName || 'Аноним',
                text,
            },
        ])
        .select();

    if (error) return res.status(500).json({ error: error.message });
    res.json(data[0]);
});

// --- ЭНДПОИНТЫ ПЛАТЕЖЕЙ ---

// Создание сессии оплаты
app.post('/api/create-checkout-session', async (req, res) => {
    const { userId } = req.body;

    try {
        const session = await stripe.checkout.sessions.create({
            payment_method_types: ['card'],
            line_items: [
                {
                    price: process.env.STRIPE_PRICE_ID,
                    quantity: 1,
                },
            ],
            mode: 'subscription',
            client_reference_id: userId,
            success_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}?success=true`,
            cancel_url: `${process.env.CLIENT_URL || 'http://localhost:3000'}?canceled=true`,
        });

        res.json({ url: session.url });
    } catch (error) {
        res.status(500).json({ error: error.message });
    }
});

// Проверка работы сервера
app.get('/', (req, res) => {
    res.send('SaaS Messenger Backend is running!');
});

app.listen(port, () => {
    console.log(`Сервер запущен на порту ${port}`);
});