
import { describe, it, expect, vi, beforeEach } from 'vitest';
import leftovers from './../src/routes/leftovers';
import { createMockEnv, testNeeds } from './fixtures';
import { createJWT } from './../src/lib/utils';

// Helper to create test request
function createRequest(path: string, options: {
  method?: string;
  body?: unknown;
  headers?: Record<string, string>;
} = {}) {
  const url = `http://localhost:8787${path}`;
  return new Request(url, {
    method: options.method || 'GET',
    headers: {
      'Content-Type': 'application/json',
      ...options.headers,
    },
    body: options.body ? JSON.stringify(options.body) : undefined,
  });
}

describe('Debug Leftovers Routes', () => {
  let mockEnv: ReturnType<typeof createMockEnv>;
  let accessToken: string;

  beforeEach(async () => {
    vi.clearAllMocks();
    mockEnv = createMockEnv();
    accessToken = await createJWT(
      { sub: 'user-003', role: 'user', neighborhood_id: 'nb-001' },
      mockEnv.JWT_SECRET,
      24
    );
  });

  describe('GET /needs', () => {
    it('should log the malformed response', async () => {
      mockEnv.DB.first.mockResolvedValueOnce({ neighborhood_id: 'nb-001' });
      mockEnv.DB.all.mockResolvedValue({ results: testNeeds });

      const req = createRequest('/needs', {
        headers: { Authorization: `Bearer ${accessToken}` },
      });

      console.log('Registered Routes:', leftovers.routes.map(r => `${r.method} ${r.path}`));

      const res = await leftovers.fetch(req, mockEnv, {} as any);
      const text = await res.text();
      console.log('--- RESPONSE START ---');
      console.log(`[${text}]`);
      console.log('--- RESPONSE END ---');
      console.log('Char codes:', text.split('').map(c => c.charCodeAt(0)));
      
      try {
        JSON.parse(text);
      } catch (e) {
        console.log('JSON Parse Error:', e);
      }
    });
  });
});
