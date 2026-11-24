import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test';
import express from 'express';
import type { Server } from 'node:http';
import type { AddressInfo } from 'node:net';

let mockConfig: Record<string, any> = {
  objectStorage: 'gdrive',
  googleDriveClientId: 'test-client-id',
  googleDriveClientSecret: 'test-client-secret',
  googleDriveRefreshToken: 'test-refresh-token',
  googleDriveFolderId: '',
  googleDriveCustomPath: 'notes/2026',
};

let mockToken: any = null;
const mockAttachments: any[] = [];
const mockConfigRows: any[] = [];

mock.module('../../../routerTrpc/config', () => ({
  getGlobalConfig: async () => mockConfig,
}));

mock.module('../../../lib/helper', () => ({
  getTokenFromRequest: async () => mockToken,
  getNextAuthSecret: async () => 'TEST_GDRIVE_SECRET_KEY',
}));

mock.module('../../../prisma', () => ({
  prisma: {
    attachments: {
      findFirst: async ({ where }: any) => {
        return mockAttachments.find((a) => a.path === where.path) || null;
      },
      create: async ({ data }: any) => {
        const created = { id: mockAttachments.length + 1, ...data };
        mockAttachments.push(created);
        return created;
      },
      delete: async ({ where }: any) => {
        const idx = mockAttachments.findIndex((a) => a.id === where.id);
        if (idx >= 0) mockAttachments.splice(idx, 1);
      },
    },
    config: {
      findMany: async ({ where }: any) => mockConfigRows.filter((r) => r.key === where.key),
      create: async ({ data }: any) => {
        const row = { id: mockConfigRows.length + 1, ...data };
        mockConfigRows.push(row);
        return row;
      },
      update: async ({ where, data }: any) => {
        const row = mockConfigRows.find((r) => r.id === where.id);
        if (row) Object.assign(row, data);
        return row;
      },
      deleteMany: async () => ({ count: 0 }),
    },
    $transaction: async (fn: any) => fn({}),
  },
}));

const { GoogleDriveService, GOOGLE_DRIVE_OAUTH_SCOPE } = await import('../../../lib/googleDrive');
const { FileService } = await import('../../../lib/files');
const { default: gdrivefileRouter } = await import('../../../routerExpress/file/gdrivefile');
const { default: gdriveOAuthRouter } = await import('../../../routerExpress/file/gdriveOAuth');

const originalFetch = globalThis.fetch;

describe('GoogleDriveService & FileService Google Drive integration', () => {
  beforeEach(() => {
    mockAttachments.length = 0;
    mockConfigRows.length = 0;
    mockToken = null;
    mockConfig = {
      objectStorage: 'gdrive',
      googleDriveClientId: 'test-client-id',
      googleDriveClientSecret: 'test-client-secret',
      googleDriveRefreshToken: 'test-refresh-token',
      googleDriveFolderId: '',
      googleDriveCustomPath: 'notes/2026',
    };
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  test('buildAuthUrl includes offline access, consent prompt, and drive.file scope', () => {
    const url = new URL(GoogleDriveService.buildAuthUrl({
      clientId: 'cid-123',
      redirectUri: 'https://blinko.example/api/gdrive/oauth/callback',
      state: 'signed-state',
    }));

    expect(url.origin + url.pathname).toBe('https://accounts.google.com/o/oauth2/v2/auth');
    expect(url.searchParams.get('client_id')).toBe('cid-123');
    expect(url.searchParams.get('redirect_uri')).toBe('https://blinko.example/api/gdrive/oauth/callback');
    expect(url.searchParams.get('response_type')).toBe('code');
    expect(url.searchParams.get('scope')).toBe(GOOGLE_DRIVE_OAUTH_SCOPE);
    expect(url.searchParams.get('access_type')).toBe('offline');
    expect(url.searchParams.get('prompt')).toBe('consent');
    expect(url.searchParams.get('state')).toBe('signed-state');
  });

  test('uploadFile creates nested folders, uploads via multipart, stores googleDriveFileId in metadata, and deletes cleanly', async () => {
    const calls: Array<{ url: string; method: string }> = [];

    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method || 'GET';
      calls.push({ url, method });

      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-access-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.startsWith('https://www.googleapis.com/drive/v3/files?') && method === 'GET') {
        return new Response(JSON.stringify({ files: [] }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.startsWith('https://www.googleapis.com/drive/v3/files?fields=id,name') && method === 'POST') {
        const body = JSON.parse(String(init?.body || '{}'));
        return new Response(JSON.stringify({ id: `folder-${body.name}`, name: body.name }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=multipart') && method === 'POST') {
        return new Response(JSON.stringify({ id: 'gdrive-file-001', name: 'hello.txt' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url === 'https://www.googleapis.com/drive/v3/files/gdrive-file-001?alt=media' && method === 'GET') {
        return new Response('hello google drive', {
          status: 200,
          headers: { 'Content-Type': 'text/plain' },
        });
      }

      if (url === 'https://www.googleapis.com/drive/v3/files/gdrive-file-001' && method === 'DELETE') {
        return new Response(null, { status: 204 });
      }

      return new Response(JSON.stringify({ error: { message: `Unexpected ${method} ${url}` } }), { status: 500 });
    }) as any;

    const uploaded = await FileService.uploadFile({
      buffer: Buffer.from('hello google drive'),
      originalName: 'hello.txt',
      type: 'text/plain',
      accountId: 1,
    });

    expect(uploaded.filePath).toMatch(/^\/api\/gdrivefile\/notes\/2026\/hello_\d+\.txt$/);
    expect(mockAttachments).toHaveLength(1);
    expect(mockAttachments[0].metadata).toEqual({ googleDriveFileId: 'gdrive-file-001' });
    expect(mockAttachments[0].perfixPath).toBe('notes,2026');

    const downloaded = await FileService.getFileBuffer(uploaded.filePath);
    expect(downloaded.toString()).toBe('hello google drive');

    await FileService.deleteFile(uploaded.filePath);
    expect(mockAttachments).toHaveLength(0);
    expect(calls.some((c) => c.method === 'DELETE' && c.url.endsWith('/files/gdrive-file-001'))).toBe(true);
  });

  test('uploadStream uses Google Drive resumable upload protocol', async () => {
    mockConfig.googleDriveFolderId = 'fixed-root-folder';
    mockConfig.googleDriveCustomPath = '';

    globalThis.fetch = (async (input: any, init?: RequestInit) => {
      const url = typeof input === 'string' ? input : input.toString();
      const method = init?.method || 'GET';

      if (url.startsWith('https://oauth2.googleapis.com/token')) {
        return new Response(JSON.stringify({ access_token: 'mock-access-token', expires_in: 3600 }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      if (url.startsWith('https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable') && method === 'POST') {
        return new Response(null, {
          status: 200,
          headers: { location: 'https://www.googleapis.com/upload/drive/v3/files?uploadType=resumable&upload_id=session-1' },
        });
      }

      if (url.includes('upload_id=session-1') && method === 'PUT') {
        return new Response(JSON.stringify({ id: 'gdrive-stream-002', name: 'stream.bin' }), {
          status: 200,
          headers: { 'Content-Type': 'application/json' },
        });
      }

      return new Response('unexpected', { status: 500 });
    }) as any;

    const stream = new ReadableStream({
      start(controller) {
        controller.enqueue(new TextEncoder().encode('streamed bytes'));
        controller.close();
      },
    });

    const result = await FileService.uploadFileStream({
      stream,
      originalName: 'stream.bin',
      fileSize: 14,
      type: 'application/octet-stream',
      accountId: 1,
    });

    expect(result.filePath).toMatch(/^\/api\/gdrivefile\/stream_\d+\.bin$/);
    expect(mockAttachments[0].metadata).toEqual({ googleDriveFileId: 'gdrive-stream-002' });
  });

  test('/api/gdrivefile proxy enforces auth, security headers, and streams private files', async () => {
    mockAttachments.push({
      id: 10,
      accountId: 42,
      path: '/api/gdrivefile/docs/secret.txt',
      name: 'secret.txt',
      type: 'text/plain',
      metadata: { googleDriveFileId: 'gdrive-secret-id' },
      note: null,
    });

    const app = express();
    app.use(express.json());
    app.use('/api/gdrivefile', gdrivefileRouter);
    app.use('/api/gdrive', gdriveOAuthRouter);

    const server: Server = await new Promise((resolve) => {
      const s = app.listen(0, '127.0.0.1', () => resolve(s));
    });
    const { port } = server.address() as AddressInfo;
    const baseUrl = `http://127.0.0.1:${port}`;

    try {
      // 1. Unauthenticated request -> 401
      const unauthRes = await originalFetch(`${baseUrl}/api/gdrivefile/docs/secret.txt`);
      expect(unauthRes.status).toBe(401);

      // 2. Wrong user -> 403
      mockToken = { id: '99', role: 'user' };
      const forbiddenRes = await originalFetch(`${baseUrl}/api/gdrivefile/docs/secret.txt`);
      expect(forbiddenRes.status).toBe(403);

      // 3. Unregistered file -> 404
      const notFoundRes = await originalFetch(`${baseUrl}/api/gdrivefile/docs/unknown.txt`);
      expect(notFoundRes.status).toBe(404);

      // 4. Owner -> 200 proxied from Google Drive with security headers
      mockToken = { id: '42', role: 'user' };
      globalThis.fetch = (async (input: any) => {
        const url = typeof input === 'string' ? input : input.toString();
        if (url.startsWith('https://oauth2.googleapis.com/token')) {
          return new Response(JSON.stringify({ access_token: 'mock-access-token', expires_in: 3600 }), {
            status: 200,
            headers: { 'Content-Type': 'application/json' },
          });
        }
        if (url.includes('/files/gdrive-secret-id?alt=media')) {
          return new Response('top secret drive content', {
            status: 200,
            headers: {
              'Content-Type': 'text/plain',
              'Content-Length': '24',
              'Accept-Ranges': 'bytes',
            },
          });
        }
        return originalFetch(input);
      }) as any;

      const okRes = await originalFetch(`${baseUrl}/api/gdrivefile/docs/secret.txt`);
      expect(okRes.status).toBe(200);
      expect(await okRes.text()).toBe('top secret drive content');
      expect(okRes.headers.get('x-content-type-options')).toBe('nosniff');
      expect(okRes.headers.get('cache-control')).toBe('private, no-store');

      // 5. Non-superadmin cannot access /api/gdrive/oauth/url or /api/gdrive/test
      const oauthForbidden = await originalFetch(`${baseUrl}/api/gdrive/oauth/url`);
      expect(oauthForbidden.status).toBe(403);

      // 6. Superadmin can get OAuth URL
      mockToken = { id: '1', role: 'superadmin' };
      const oauthOk = await originalFetch(`${baseUrl}/api/gdrive/oauth/url`);
      expect(oauthOk.status).toBe(200);
      const oauthJson = await oauthOk.json() as any;
      expect(oauthJson.authUrl).toContain('https://accounts.google.com/o/oauth2/v2/auth');
      expect(oauthJson.redirectUri).toBe(`${baseUrl}/api/gdrive/oauth/callback`);
    } finally {
      server.close();
    }
  });
});
