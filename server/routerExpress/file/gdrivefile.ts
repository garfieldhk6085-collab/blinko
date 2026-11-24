import express, { Request, Response } from 'express';
import { Readable } from 'stream';
import sharp from 'sharp';
import mime from 'mime-types';
import { FileService } from '../../lib/files';
import { GoogleDriveService } from '../../lib/googleDrive';
import { getTokenFromRequest } from '../../lib/helper';
import { prisma } from '../../prisma';
import { canReadFile, uploadedFileHeaders } from '../../lib/fileAccessPolicy';
import { validAttachmentShareToken } from '../../lib/attachmentShare';

const router = express.Router();

function isImage(filename: string): boolean {
  const imageExtensions = ['.jpg', '.jpeg', '.png', '.gif', '.webp'];
  return imageExtensions.some((ext) => filename.toLowerCase().endsWith(ext));
}

async function generateThumbnail(fileId: string): Promise<Buffer> {
  const buffer = await GoogleDriveService.downloadBuffer(fileId);
  const metadata = await sharp(buffer).metadata();
  const { width = 0, height = 0 } = metadata;

  let resizeWidth = width;
  let resizeHeight = height;
  const maxDimension = 500;

  if (width > height && width > maxDimension) {
    resizeWidth = maxDimension;
    resizeHeight = Math.round(height * (maxDimension / width));
  } else if (height > maxDimension) {
    resizeHeight = maxDimension;
    resizeWidth = Math.round(width * (maxDimension / height));
  }

  return await sharp(buffer, {
    failOnError: false,
    limitInputPixels: false,
  })
    .rotate()
    .resize(resizeWidth, resizeHeight, {
      fit: 'contain',
      background: { r: 0, g: 0, b: 0, alpha: 0 },
      withoutEnlargement: true,
    })
    .toBuffer();
}

async function streamGoogleDriveResponse(
  fileId: string,
  req: Request,
  res: Response,
  fileHeaders: Record<string, string>
) {
  const rangeHeader = typeof req.headers.range === 'string' ? req.headers.range : undefined;
  const driveResponse = await GoogleDriveService.downloadStream(fileId, rangeHeader);

  res.set(fileHeaders);

  const contentLength = driveResponse.headers.get('content-length');
  const contentRange = driveResponse.headers.get('content-range');
  const acceptRanges = driveResponse.headers.get('accept-ranges');

  if (contentLength) res.set('Content-Length', contentLength);
  if (contentRange) res.set('Content-Range', contentRange);
  if (acceptRanges) res.set('Accept-Ranges', acceptRanges);

  res.status(driveResponse.status === 206 ? 206 : 200);

  if (!driveResponse.body) {
    return res.end();
  }

  const nodeStream = Readable.fromWeb(driveResponse.body as any);
  nodeStream.on('error', (err) => {
    console.error('Google Drive proxy stream error:', err);
    if (!res.headersSent) {
      res.status(502).json({ error: 'Failed to stream file from Google Drive' });
    } else {
      res.end();
    }
  });
  req.on('close', () => {
    nodeStream.destroy();
  });

  nodeStream.pipe(res);
}

/**
 * @swagger
 * /api/gdrivefile/{path}:
 *   get:
 *     tags:
 *       - File
 *     summary: Get Google Drive File (Proxied)
 *     operationId: getGoogleDriveFile
 *     parameters:
 *       - in: path
 *         name: path
 *         schema:
 *           type: string
 *         required: true
 *         description: Path to the Google Drive file
 *       - in: query
 *         name: thumbnail
 *         schema:
 *           type: boolean
 *         required: false
 *         description: Whether to return a thumbnail (only for images)
 *     responses:
 *       200:
 *         description: Success
 *       401:
 *         description: Unauthorized
 *       403:
 *         description: Forbidden
 *       404:
 *         description: File not found
 *     security:
 *       - bearer: []
 */
//@ts-ignore
router.get(/.*/, async (req: Request, res: Response) => {
  try {
    const token = await getTokenFromRequest(req);
    const fullPath = decodeURIComponent(req.path.substring(1));
    const needThumbnail = req.query.thumbnail === 'true';

    if (fullPath.includes('..') || fullPath.includes('\\..') || fullPath.includes('/..')) {
      return res.status(400).json({ error: 'Invalid path' });
    }

    let fileId: string | undefined;

    if (!fullPath.includes('temp/')) {
      try {
        const myFile = await prisma.attachments.findFirst({
          where: {
            path: '/api/gdrivefile/' + fullPath,
          },
          include: {
            note: {
              select: {
                id: true, isShare: true, accountId: true, isRecycle: true,
                sharePassword: true, shareExpiryDate: true, shareEncryptedUrl: true,
                shareMaxView: true, shareViewCount: true,
                internalShares: {
                  where: { accountId: Number(token?.id) || -1 },
                  select: { accountId: true },
                },
              },
            },
          },
        });

        if (!myFile) {
          return res.status(404).json({ error: 'File not found' });
        }

        const grant = await validAttachmentShareToken(req.query.shareToken, myFile.note);
        if (!canReadFile(myFile, token, grant)) {
          return res.status(token ? 403 : 401).json({ error: 'Unauthorized' });
        }

        const metadataFileId = (myFile.metadata as Record<string, any> | null)?.googleDriveFileId;
        if (typeof metadataFileId === 'string' && metadataFileId.length > 0) {
          fileId = metadataFileId;
        }
      } catch (error) {
        console.error('Error checking Google Drive file permissions:', error);
        return res.status(500).json({ error: 'Error checking file permissions' });
      }
    } else {
      if (token?.role !== 'superadmin') {
        return res.status(401).json({ error: 'Unauthorized' });
      }
    }

    if (!fileId) {
      fileId = await FileService.resolveGoogleDriveFileId('/api/gdrivefile/' + fullPath);
    }

    const fileHeaders = uploadedFileHeaders(
      fullPath,
      mime.lookup(fullPath) || 'application/octet-stream',
      req.query.download === 'true'
    );

    if (isImage(fullPath) && needThumbnail) {
      try {
        const thumbnail = await generateThumbnail(fileId);
        const filename = decodeURIComponent(fullPath.split('/').pop() || '');

        res.set({
          ...fileHeaders,
          'Content-Type': mime.lookup(filename) || 'image/jpeg',
          'Cache-Control': 'private, no-store',
          'Content-Disposition': `inline; filename*=UTF-8''${encodeURIComponent(filename)}`,
          'X-Content-Type-Options': 'nosniff',
        });

        return res.send(thumbnail);
      } catch (error) {
        console.error('Failed to generate Google Drive thumbnail, falling back to original:', error);
      }
    }

    return await streamGoogleDriveResponse(fileId, req, res, fileHeaders);
  } catch (error: any) {
    console.error('Google Drive file access error:', error);
    if (!res.headersSent) {
      return res.status(404).json({
        error: 'File not found',
        details: process.env.NODE_ENV === 'development' ? error.message : undefined,
      });
    }
  }
});

export default router;
