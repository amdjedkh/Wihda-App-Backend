/**
 * Wihda Backend - Store / Reward Redemption Routes
 * GET  /v1/store              — list active store items with user's redemption status
 * POST /v1/store/:id/redeem   — redeem an item (deducts coins, stores form data for Flexy)
 */

import { Hono } from 'hono';
import { z } from 'zod';
import type { Env } from '../types';
import { authMiddleware, getAuthContext } from '../middleware/auth';
import { successResponse, errorResponse, generateId } from '../lib/utils';

const store = new Hono<{ Bindings: Env }>();

const redeemSchema = z.object({
  full_name:    z.string().min(2).max(100).optional(),
  phone_number: z.string().min(7).max(20).optional(),
});

// ── GET /v1/store ─────────────────────────────────────────────────────────────

store.get('/', authMiddleware, async (c) => {
  const auth = getAuthContext(c);
  if (!auth) return errorResponse('UNAUTHORIZED', 'Auth required', 401);

  const items = await c.env.DB.prepare(
    'SELECT * FROM store_items ORDER BY is_active DESC, category, price_coins'
  ).all();

  const redemptions = await c.env.DB.prepare(
    'SELECT item_id, full_name, phone_number, delivery_status, redeemed_at FROM store_redemptions WHERE user_id = ?'
  ).bind(auth.userId).all();

  const redeemedMap = new Map(
    (redemptions.results as any[]).map((r) => [r.item_id, r])
  );

  const balanceRow = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(amount),0) as balance FROM coin_ledger_entries WHERE user_id = ? AND voided_at IS NULL'
  ).bind(auth.userId).first<{ balance: number }>();

  const coinBalance = balanceRow?.balance ?? 0;

  return successResponse({
    coin_balance: coinBalance,
    items: (items.results as any[]).map((item) => {
      const redemption = redeemedMap.get(item.id);
      return {
        ...item,
        redeemed:   !!redemption,
        can_afford: coinBalance >= item.price_coins,
        redemption: redemption
          ? {
              full_name:       redemption.full_name,
              phone_number:    redemption.phone_number,
              delivery_status: redemption.delivery_status,
              redeemed_at:     redemption.redeemed_at,
            }
          : null,
      };
    }),
  });
});

// ── POST /v1/store/:id/redeem ─────────────────────────────────────────────────

store.post('/:id/redeem', authMiddleware, async (c) => {
  const auth = getAuthContext(c);
  if (!auth) return errorResponse('UNAUTHORIZED', 'Auth required', 401);

  const itemId = c.req.param('id');

  const item = await c.env.DB.prepare(
    'SELECT * FROM store_items WHERE id = ? AND is_active = 1'
  ).bind(itemId).first<any>();

  if (!item) return errorResponse('NOT_FOUND', 'Item not found or not available', 404);

  // Parse optional body (Flexy requires full_name + phone_number)
  const rawBody = await c.req.json().catch(() => ({}));
  const bodyParse = redeemSchema.safeParse(rawBody);
  if (!bodyParse.success) {
    return errorResponse('VALIDATION_ERROR', 'Invalid request data', 400, bodyParse.error.flatten());
  }
  const { full_name, phone_number } = bodyParse.data;

  // Require form data for the Flexy item
  if (item.id === 'item-flexy') {
    if (!full_name?.trim()) {
      return errorResponse('VALIDATION_ERROR', 'Full name is required to redeem Flexy', 400);
    }
    if (!phone_number?.trim()) {
      return errorResponse('VALIDATION_ERROR', 'Phone number is required to redeem Flexy', 400);
    }
  }

  // Check already redeemed
  const existing = await c.env.DB.prepare(
    'SELECT id FROM store_redemptions WHERE user_id = ? AND item_id = ?'
  ).bind(auth.userId, itemId).first();

  if (existing) return errorResponse('ALREADY_REDEEMED', 'You have already redeemed this item', 409);

  // Check coin balance
  const balanceRow = await c.env.DB.prepare(
    'SELECT COALESCE(SUM(amount),0) as balance FROM coin_ledger_entries WHERE user_id = ? AND voided_at IS NULL'
  ).bind(auth.userId).first<{ balance: number }>();

  const balance = balanceRow?.balance ?? 0;
  if (balance < item.price_coins) {
    return errorResponse(
      'INSUFFICIENT_COINS',
      `You need ${item.price_coins} coins but only have ${balance}`,
      400,
      { required: item.price_coins, balance },
    );
  }

  const redemptionId = generateId();
  const neighborhoodId = auth.neighborhoodId ?? 'system';
  const ledgerEntryId = generateId();

  // Deduct coins via ledger entry (negative amount)
  await c.env.DB.prepare(
    `INSERT INTO coin_ledger_entries (id, user_id, neighborhood_id, source_type, source_id, amount, category, description, created_by, created_at)
     VALUES (?, ?, ?, 'store_redemption', ?, ?, 'store', ?, 'system', datetime('now'))`
  ).bind(ledgerEntryId, auth.userId, neighborhoodId, redemptionId, -item.price_coins, `Redeemed: ${item.name}`).run();

  // Record redemption with form data
  await c.env.DB.prepare(
    `INSERT INTO store_redemptions (id, user_id, item_id, coins_spent, full_name, phone_number, delivery_status, redeemed_at)
     VALUES (?, ?, ?, ?, ?, ?, 'pending', datetime('now'))`
  ).bind(
    redemptionId,
    auth.userId,
    itemId,
    item.price_coins,
    full_name?.trim() ?? null,
    phone_number?.trim() ?? null,
  ).run();

  return successResponse({
    redeemed:     true,
    coins_spent:  item.price_coins,
    item_name:    item.name,
    delivery_status: 'pending',
    message:      item.id === 'item-flexy'
      ? 'Your Flexy will be sent within 48 hours'
      : 'Item redeemed successfully',
  });
});

export default store;
