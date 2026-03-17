/**
 * Badge auto-awarding utility.
 * Call checkAndAwardBadges after any action that increases progress counters.
 */

import type { D1Database } from "@cloudflare/workers-types";

export async function checkAndAwardBadges(
  db: D1Database,
  userId: string,
): Promise<void> {
  try {
    // Count current progress metrics
    const [offersRow, cleanifyRow] = await Promise.all([
      db.prepare("SELECT COUNT(*) as cnt FROM leftover_offers WHERE user_id = ?")
        .bind(userId).first<{ cnt: number }>(),
      db.prepare("SELECT COUNT(*) as cnt FROM cleanify_submissions WHERE user_id = ? AND status = 'approved'")
        .bind(userId).first<{ cnt: number }>(),
    ]);

    const leftoverOffers = offersRow?.cnt ?? 0;
    const cleanifyApproved = cleanifyRow?.cnt ?? 0;
    const totalActions = leftoverOffers + cleanifyApproved;

    const progress: Record<string, number> = {
      leftover_offers:  leftoverOffers,
      cleanify_approved: cleanifyApproved,
      total_actions:    totalActions,
    };

    // Fetch all badge definitions
    const badgesResult = await db.prepare(
      "SELECT key, requirement_type, requirement_value FROM badges"
    ).all<{ key: string; requirement_type: string; requirement_value: number }>();

    // Fetch already-earned badge keys
    const earnedResult = await db.prepare(
      "SELECT badge_key FROM user_badges WHERE user_id = ?"
    ).bind(userId).all<{ badge_key: string }>();

    const earned = new Set(earnedResult.results.map((r) => r.badge_key));

    // Award any newly unlocked badges
    const toAward = badgesResult.results.filter((badge) => {
      if (earned.has(badge.key)) return false;
      const current = progress[badge.requirement_type] ?? 0;
      return current >= badge.requirement_value;
    });

    for (const badge of toAward) {
      await db.prepare(
        "INSERT OR IGNORE INTO user_badges (id, user_id, badge_key, earned_at) VALUES (?, ?, ?, datetime('now'))"
      ).bind(crypto.randomUUID(), userId, badge.key).run();
    }
  } catch (err) {
    // Badge awarding is non-critical; never let it break the main request
    console.error("checkAndAwardBadges error:", err);
  }
}
