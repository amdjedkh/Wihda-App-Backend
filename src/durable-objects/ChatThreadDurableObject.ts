/**
 * Wihda Backend - Chat Thread Durable Object
 * Handles WebSocket connections and real-time messaging
 */

import type { Env } from '../types';

interface WebSocketMessage {
  type: 'message' | 'typing' | 'read' | 'ping' | 'user_joined' | 'user_left' | 'connected' | 'error' | 'pong';
  payload: unknown;
}

interface Client {
  userId: string;
  websocket: WebSocket;
}

export class ChatThreadDurableObject {
  private env: Env;
  private clients: Map<WebSocket, Client>;
  private threadId: string | null = null;

  constructor(_state: DurableObjectState, env: Env) {
    this.env = env;
    this.clients = new Map();
  }

  async fetch(request: Request): Promise<Response> {
    const url = new URL(request.url);
    
    // Handle WebSocket upgrade
    if (request.headers.get('Upgrade') === 'websocket') {
      return this.handleWebSocket(request);
    }
    
    // Handle HTTP requests
    if (url.pathname === '/ws') {
      return this.handleWebSocket(request);
    }
    
    // Health check
    if (url.pathname === '/health') {
      return new Response(JSON.stringify({ status: 'ok', clients: this.clients.size }), {
        headers: { 'Content-Type': 'application/json' }
      });
    }
    
    // Broadcast message
    if (url.pathname === '/broadcast' && request.method === 'POST') {
      const body = await request.json() as { message: WebSocketMessage; excludeUserId?: string };
      this.broadcast(body.message, body.excludeUserId);
      return new Response(JSON.stringify({ success: true }));
    }
    
    return new Response('Not Found', { status: 404 });
  }

  private async handleWebSocket(request: Request): Promise<Response> {
    const userId = request.headers.get('X-User-Id');
    const threadId = request.headers.get('X-Thread-Id');
    
    if (!userId || !threadId) {
      return new Response('Missing user or thread ID', { status: 400 });
    }
    
    this.threadId = threadId;
    
    // Create WebSocket pair
    const pair = new WebSocketPair();
    const [client, server] = Object.values(pair);
    
    // Set up server WebSocket
    server.accept();
    
    // Store client info
    this.clients.set(server, { userId, websocket: server });
    
    // Handle messages from client
    server.addEventListener('message', (event: MessageEvent) => {
      this.handleMessage(server, event.data as string);
    });
    
    // Handle close
    server.addEventListener('close', () => {
      this.clients.delete(server);
      this.broadcastUserLeft(userId);
    });
    
    // Handle error
    server.addEventListener('error', (event: ErrorEvent) => {
      console.error('WebSocket error:', event.error);
      this.clients.delete(server);
    });
    
    // Send welcome message
    server.send(JSON.stringify({
      type: 'connected',
      payload: {
        thread_id: threadId,
        user_id: userId,
        connected_users: this.getConnectedUsers()
      }
    }));
    
    // Notify others that user joined
    this.broadcastUserJoined(userId);
    
    return new Response(null, {
      status: 101,
      webSocket: client
    });
  }

  private handleMessage(ws: WebSocket, data: string): void {
    const client = this.clients.get(ws);
    if (!client) return;
    
    try {
      const message = JSON.parse(data) as WebSocketMessage;
      
      switch (message.type) {
        case 'message':
          // Validate and store message
          this.handleChatMessage(client, message.payload);
          break;
          
        case 'typing':
          // Broadcast typing indicator
          this.broadcast({
            type: 'typing',
            payload: {
              user_id: client.userId,
              is_typing: message.payload
            }
          }, client.userId);
          break;
          
        case 'read':
          // Mark messages as read
          this.handleReadMessages(client);
          break;
          
        case 'ping':
          ws.send(JSON.stringify({ type: 'pong', payload: Date.now() }));
          break;
      }
    } catch (error) {
      console.error('Error parsing message:', error);
      ws.send(JSON.stringify({
        type: 'error',
        payload: { message: 'Invalid message format' }
      }));
    }
  }

  private async handleChatMessage(client: Client, payload: unknown): Promise<void> {
    const { body, message_type = 'text', media_url } = payload as {
      body?: string;
      message_type?: string;
      media_url?: string;
    };
    
    if (!body || typeof body !== 'string' || body.length > 2000) {
      client.websocket.send(JSON.stringify({
        type: 'error',
        payload: { message: 'Invalid message body' }
      }));
      return;
    }
    
    if (!this.threadId) {
      client.websocket.send(JSON.stringify({
        type: 'error',
        payload: { message: 'Thread not initialized' }
      }));
      return;
    }
    
    try {
      // Store message in D1
      const messageId = crypto.randomUUID();
      const now = new Date().toISOString();
      
      await this.env.DB.prepare(`
        INSERT INTO chat_messages (id, thread_id, sender_id, body, message_type, media_url, created_at)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).bind(
        messageId,
        this.threadId,
        client.userId,
        body,
        message_type,
        media_url || null,
        now
      ).run();
      
      // Update thread's last_message_at
      await this.env.DB.prepare(`
        UPDATE chat_threads SET last_message_at = ? WHERE id = ?
      `).bind(now, this.threadId).run();
      
      // Broadcast to all connected clients
      this.broadcast({
        type: 'message',
        payload: {
          id: messageId,
          thread_id: this.threadId,
          sender_id: client.userId,
          body,
          message_type,
          media_url,
          created_at: now
        }
      });
    } catch (error) {
      console.error('Error storing message:', error);
      client.websocket.send(JSON.stringify({
        type: 'error',
        payload: { message: 'Failed to send message' }
      }));
    }
  }

  private async handleReadMessages(client: Client): Promise<void> {
    if (!this.threadId) return;
    
    const now = new Date().toISOString();
    
    await this.env.DB.prepare(`
      UPDATE chat_messages 
      SET read_at = ? 
      WHERE thread_id = ? AND sender_id != ? AND read_at IS NULL
    `).bind(now, this.threadId, client.userId).run();
    
    // Broadcast read receipt
    this.broadcast({
      type: 'read',
      payload: {
        thread_id: this.threadId,
        read_by: client.userId,
        read_at: now
      }
    }, client.userId);
  }

  private broadcast(message: WebSocketMessage, excludeUserId?: string): void {
    const messageStr = JSON.stringify(message);
    
    for (const [ws, client] of this.clients) {
      if (excludeUserId && client.userId === excludeUserId) continue;
      
      try {
        ws.send(messageStr);
      } catch (error) {
        console.error('Error broadcasting to client:', error);
        this.clients.delete(ws);
      }
    }
  }

  private broadcastUserJoined(userId: string): void {
    this.broadcast({
      type: 'user_joined',
      payload: {
        user_id: userId,
        connected_users: this.getConnectedUsers()
      }
    }, userId);
  }

  private broadcastUserLeft(userId: string): void {
    this.broadcast({
      type: 'user_left',
      payload: {
        user_id: userId,
        connected_users: this.getConnectedUsers()
      }
    });
  }

  private getConnectedUsers(): string[] {
    const users = new Set<string>();
    for (const client of this.clients.values()) {
      users.add(client.userId);
    }
    return Array.from(users);
  }
}

export default ChatThreadDurableObject;
