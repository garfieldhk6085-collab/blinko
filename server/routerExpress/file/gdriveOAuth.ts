import express, { Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { getTokenFromRequest, getNextAuthSecret } from '../../lib/helper';
import { getGlobalConfig } from '../../routerTrpc/config';
import { GoogleDriveService } from '../../lib/googleDrive';
import { prisma } from '../../prisma';

const router = express.Router();

const OAUTH_STATE_AUDIENCE = 'blinko-gdrive-oauth';

function getOriginFromRequest(req: Request): string {
  const forwardedProto = (req.headers['x-forwarded-proto'] as string | undefined)?.split(',')[0]?.trim();
  const protocol = forwardedProto || req.protocol || 'http';
  const host = (req.headers['x-forwarded-host'] as string | undefined)?.split(',')[0]?.trim() || req.get('host');
  return `${protocol}://${host}`;
}

async function upsertGlobalConfigValue(key: string, value: string): Promise<void> {
  const matchedConfigs = await prisma.config.findMany({ where: { key } });
  if (matchedConfigs.length > 0) {
    const configToKeep = matchedConfigs[0]!;
    await prisma.config.update({
      where: { id: configToKeep.id },
      data: { config: { type: typeof value, value } },
    });
    if (matchedConfigs.length > 1) {
      await prisma.config.deleteMany({
        where: {
          key,
          id: { notIn: [configToKeep.id] },
        },
      });
    }
  } else {
    await prisma.config.create({
      data: { key, config: { type: typeof value, value } },
    });
  }
}

function renderOAuthResultHtml(payload: { success: boolean; message: string }): string {
  const serialized = JSON.stringify({
    type: 'blinko-gdrive-oauth',
    success: payload.success,
    message: payload.message,
  });
  const title = payload.success ? 'Google Drive Connected' : 'Google Drive Authorization Failed';
  const escapedMessage = payload.message
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;');

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8" />
  <title>${title}</title>
  <style>
    body { font-family: system-ui, -apple-system, sans-serif; display: flex; align-items: center; justify-content: center; min-height: 100vh; margin: 0; background: #f8fafc; color: #0f172a; }
    .card { max-width: 420px; padding: 24px 28px; border-radius: 12px; background: #fff; box-shadow: 0 4px 24px rgba(0,0,0,0.08); text-align: center; }
    h1 { font-size: 18px; margin: 0 0 10px; }
    p { font-size: 14px; color: #475569; margin: 0 0 16px; word-break: break-word; }
  </style>
</head>
<body>
  <div class="card">
    <h1>${title}</h1>
    <p>${escapedMessage}</p>
  </div>
  <script>
    (function() {
      var data = ${serialized};
      try {
        if (window.opener && !window.opener.closed) {
          window.opener.postMessage(data, window.location.origin);
          if (data.success) {
            setTimeout(function() { window.close(); }, 800);
          }
        }
      } catch (e) {}
    })();
  </script>
</body>
</html>`;
}

/**
 * GET /api/gdrive/oauth/url
 * Generates a signed Google OAuth 2.0 authorization URL for superadmin users.
 */
router.get('/oauth/url', async (req: Request, res: Response) => {
  try {
    const token = await getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (token.role !== 'superadmin') {
      return res.status(403).json({ error: 'Forbidden: superadmin required' });
    }

    const config = await getGlobalConfig({ useAdmin: true });
    const clientId = String(config.googleDriveClientId || '').trim();
    const clientSecret = String(config.googleDriveClientSecret || '').trim();
    if (!clientId || !clientSecret) {
      return res.status(400).json({ error: 'Please save Google Drive Client ID and Client Secret first' });
    }

    const secret = await getNextAuthSecret();
    if (!secret) {
      return res.status(500).json({ error: 'Server signing secret is unavailable' });
    }

    const redirectUri = `${getOriginFromRequest(req)}/api/gdrive/oauth/callback`;
    const state = jwt.sign(
      { userId: Number(token.id), redirectUri },
      secret,
      { algorithm: 'HS256', audience: OAUTH_STATE_AUDIENCE, expiresIn: '10m' }
    );

    const authUrl = GoogleDriveService.buildAuthUrl({
      clientId,
      redirectUri,
      state,
    });

    return res.json({ authUrl, redirectUri });
  } catch (error: any) {
    console.error('Failed to build Google Drive OAuth URL:', error);
    return res.status(500).json({ error: error.message || 'Failed to build OAuth URL' });
  }
});

/**
 * GET /api/gdrive/oauth/callback
 * Handles Google OAuth 2.0 redirect, verifies signed state, exchanges code for refresh_token,
 * and saves it to global config.
 */
router.get('/oauth/callback', async (req: Request, res: Response) => {
  try {
    const errorParam = req.query.error as string | undefined;
    if (errorParam) {
      return res.status(400).send(renderOAuthResultHtml({
        success: false,
        message: `Google authorization returned error: ${errorParam}`,
      }));
    }

    const code = typeof req.query.code === 'string' ? req.query.code : '';
    const state = typeof req.query.state === 'string' ? req.query.state : '';
    if (!code || !state) {
      return res.status(400).send(renderOAuthResultHtml({
        success: false,
        message: 'Missing authorization code or state parameter.',
      }));
    }

    const secret = await getNextAuthSecret();
    if (!secret) {
      return res.status(500).send(renderOAuthResultHtml({
        success: false,
        message: 'Server signing secret is unavailable.',
      }));
    }

    let statePayload: jwt.JwtPayload;
    try {
      statePayload = jwt.verify(state, secret, {
        algorithms: ['HS256'],
        audience: OAUTH_STATE_AUDIENCE,
      }) as jwt.JwtPayload;
    } catch {
      return res.status(400).send(renderOAuthResultHtml({
        success: false,
        message: 'Invalid or expired OAuth state. Please try authorizing again.',
      }));
    }

    const redirectUri = typeof statePayload.redirectUri === 'string'
      ? statePayload.redirectUri
      : `${getOriginFromRequest(req)}/api/gdrive/oauth/callback`;

    const config = await getGlobalConfig({ useAdmin: true });
    const clientId = String(config.googleDriveClientId || '').trim();
    const clientSecret = String(config.googleDriveClientSecret || '').trim();
    if (!clientId || !clientSecret) {
      return res.status(400).send(renderOAuthResultHtml({
        success: false,
        message: 'Google Drive Client ID or Client Secret is not configured.',
      }));
    }

    const tokens = await GoogleDriveService.exchangeCodeForTokens({
      clientId,
      clientSecret,
      code,
      redirectUri,
    });

    if (!tokens.refreshToken) {
      return res.status(400).send(renderOAuthResultHtml({
        success: false,
        message: 'Google did not return a refresh token. Please revoke previous app access in your Google Account and authorize again.',
      }));
    }

    await upsertGlobalConfigValue('googleDriveRefreshToken', tokens.refreshToken);

    return res.status(200).send(renderOAuthResultHtml({
      success: true,
      message: 'Google Drive refresh token saved successfully. You may close this window.',
    }));
  } catch (error: any) {
    console.error('Google Drive OAuth callback error:', error);
    return res.status(500).send(renderOAuthResultHtml({
      success: false,
      message: error.message || 'OAuth authorization failed.',
    }));
  }
});

/**
 * POST /api/gdrive/test
 * Tests Google Drive OAuth 2.0 connection using saved credentials (or optional overrides).
 */
router.post('/test', async (req: Request, res: Response) => {
  try {
    const token = await getTokenFromRequest(req);
    if (!token) {
      return res.status(401).json({ error: 'Unauthorized' });
    }
    if (token.role !== 'superadmin') {
      return res.status(403).json({ error: 'Forbidden: superadmin required' });
    }

    const saved = await getGlobalConfig({ useAdmin: true });
    const body = (req.body || {}) as Record<string, any>;

    const clientId = String(body.clientId ?? saved.googleDriveClientId ?? '').trim();
    const clientSecret = String(body.clientSecret ?? saved.googleDriveClientSecret ?? '').trim();
    const refreshToken = String(body.refreshToken ?? saved.googleDriveRefreshToken ?? '').trim();
    const folderId = String(body.folderId ?? saved.googleDriveFolderId ?? '').trim() || undefined;

    if (!clientId || !clientSecret || !refreshToken) {
      return res.status(400).json({ error: 'Client ID, Client Secret, and Refresh Token are required' });
    }

    const info = await GoogleDriveService.testConnection({
      clientId,
      clientSecret,
      refreshToken,
      folderId,
    });

    return res.json({ success: true, ...info });
  } catch (error: any) {
    console.error('Google Drive connection test failed:', error);
    return res.status(400).json({
      success: false,
      error: error.message || 'Connection test failed',
    });
  }
});

export default router;
