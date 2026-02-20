/**
 * Wihda Backend - Notification Queue Consumer
 * Handles push notifications via FCM
 */

import type { Env, NotificationQueueMessage } from '../types';
import { getUserById } from '../lib/db';

/**
 * Send push notification via Firebase Cloud Messaging
 */
async function sendFCMNotification(
  serverKey: string,
  token: string,
  notification: {
    title: string;
    body: string;
  },
  data?: Record<string, unknown>
): Promise<boolean> {
  if (!serverKey) {
    console.log('FCM server key not configured, skipping notification');
    return false;
  }
  
  try {
    const response = await fetch('https://fcm.googleapis.com/fcm/send', {
      method: 'POST',
      headers: {
        'Authorization': `key=${serverKey}`,
        'Content-Type': 'application/json'
      },
      body: JSON.stringify({
        to: token,
        notification,
        data: data || {}
      })
    });
    
    if (!response.ok) {
      const error = await response.text();
      console.error('FCM error:', error);
      return false;
    }
    
    const result = await response.json() as { success?: number; failure?: number };
    return result.success === 1;
  } catch (error) {
    console.error('FCM send error:', error);
    return false;
  }
}

/**
 * Store notification in database
 */
async function storeNotification(
  db: D1Database,
  notification: NotificationQueueMessage
): Promise<string> {
  const id = crypto.randomUUID();
  const now = new Date().toISOString();
  
  await db.prepare(`
    INSERT INTO notifications (id, user_id, type, title, body, data, created_at)
    VALUES (?, ?, ?, ?, ?, ?, ?)
  `).bind(
    id,
    notification.user_id,
    notification.type,
    notification.title,
    notification.body,
    notification.data ? JSON.stringify(notification.data) : null,
    now
  ).run();
  
  return id;
}

/**
 * Main queue handler for notifications
 */
export async function handleNotificationQueue(
  batch: MessageBatch<NotificationQueueMessage>,
  env: Env
): Promise<void> {
  for (const message of batch.messages) {
    const notification = message.body;
    
    try {
      // Store notification in database
      await storeNotification(env.DB, notification);
      
      // Get user's FCM token
      const user = await getUserById(env.DB, notification.user_id);
      
      if (user?.fcm_token) {
        // Send push notification
        await sendFCMNotification(
          env.FCM_SERVER_KEY,
          user.fcm_token,
          {
            title: notification.title,
            body: notification.body
          },
          notification.data
        );
      }
      
      message.ack();
    } catch (error) {
      console.error('Notification error:', error);
      message.retry();
    }
  }
}

/**
 * Get user's notification history
 */
export async function getNotificationHistory(
  db: D1Database,
  userId: string,
  limit: number = 20,
  unreadOnly: boolean = false
): Promise<{ notifications: any[]; hasMore: boolean }> {
  let query = 'SELECT * FROM notifications WHERE user_id = ?';
  const params: (string | number)[] = [userId];
  
  if (unreadOnly) {
    query += ' AND read_at IS NULL';
  }
  
  query += ' ORDER BY created_at DESC LIMIT ?';
  params.push(limit + 1);
  
  const result = await db.prepare(query).bind(...params).all();
  const notifications = result.results.slice(0, limit);
  const hasMore = result.results.length > limit;
  
  return {
    notifications: notifications.map((n: any) => ({
      id: n.id,
      type: n.type,
      title: n.title,
      body: n.body,
      data: n.data ? JSON.parse(n.data) : null,
      read_at: n.read_at,
      created_at: n.created_at
    })),
    hasMore
  };
}

/**
 * Mark notifications as read
 */
export async function markNotificationsRead(
  db: D1Database,
  userId: string,
  notificationIds?: string[]
): Promise<number> {
  const now = new Date().toISOString();
  
  if (notificationIds && notificationIds.length > 0) {
    const placeholders = notificationIds.map(() => '?').join(',');
    const result = await db.prepare(`
      UPDATE notifications 
      SET read_at = ? 
      WHERE user_id = ? AND id IN (${placeholders}) AND read_at IS NULL
    `).bind(now, userId, ...notificationIds).run();
    
    return result.meta.changes;
  } else {
    // Mark all as read
    const result = await db.prepare(`
      UPDATE notifications 
      SET read_at = ? 
      WHERE user_id = ? AND read_at IS NULL
    `).bind(now, userId).run();
    
    return result.meta.changes;
  }
}
