import { OAuthHelper } from './oauthHelper.js';
import { authStore } from '../storage/authStore.js';
import { db } from '../storage/db.js';
import { getBackendBaseUrl } from '../core/config.js';

const GOOGLE_AUTH_URL = 'https://accounts.google.com/o/oauth2/v2/auth';
const GOOGLE_TOKEN_URL = 'https://oauth2.googleapis.com/token';
const GOOGLE_REVOKE_URL = 'https://oauth2.googleapis.com/revoke';
const YT_UPLOAD_URL = 'https://www.googleapis.com/upload/youtube/v3/videos';
const YT_CHANNEL_URL = 'https://www.googleapis.com/youtube/v3/channels';
const CHUNK_SIZE = 5 * 1024 * 1024;

export class YouTubeAPI {
  async getConfig() {
    const clientId = await db.getSetting('google_client_id');
    const clientSecret = await db.getSetting('google_client_secret');
    if (!clientId) throw new Error('YouTube sign-in isn\'t set up on this site yet. Please contact the site administrator.');
    return { clientId, clientSecret };
  }

  async connect() {
    const { clientId } = await this.getConfig();
    const state = OAuthHelper.generateRandomString(32);
    const { verifier, challenge } = await OAuthHelper.generatePKCE();

    await db.setSetting('google_oauth_verifier', verifier);
    await db.setSetting('google_oauth_state', state);

    const params = OAuthHelper.buildQueryString({
      client_id: clientId,
      redirect_uri: OAuthHelper.getCallbackUrl(),
      response_type: 'code',
      scope: 'https://www.googleapis.com/auth/youtube.upload https://www.googleapis.com/auth/youtube.readonly',
      access_type: 'offline',
      prompt: 'consent',
      state,
      code_challenge: challenge,
      code_challenge_method: 'S256',
    });

    const popup = OAuthHelper.openPopup(`${GOOGLE_AUTH_URL}?${params}`, 'Connect YouTube');
    const msg = await OAuthHelper.waitForOAuthMessage(popup, state);
    return this.exchangeCode(msg.code);
  }

  async exchangeCode(code) {
    const { clientId, clientSecret } = await this.getConfig();
    const verifier = await db.getSetting('google_oauth_verifier');

    const body = new URLSearchParams({
      code,
      client_id: clientId,
      client_secret: clientSecret || '',
      redirect_uri: OAuthHelper.getCallbackUrl(),
      grant_type: 'authorization_code',
      code_verifier: verifier,
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);

    const tokenData = {
      access_token: data.access_token,
      refresh_token: data.refresh_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
      scope: data.scope,
      token_type: data.token_type,
    };

    await authStore.setToken('youtube', tokenData);
    await this.fetchChannelInfo(tokenData.access_token);
    return tokenData;
  }

  async refreshToken() {
    const token = await authStore.getToken('youtube');
    if (!token?.refresh_token) throw new Error('No YouTube refresh token');
    const { clientId, clientSecret } = await this.getConfig();

    const body = new URLSearchParams({
      client_id: clientId,
      client_secret: clientSecret || '',
      grant_type: 'refresh_token',
      refresh_token: token.refresh_token,
    });

    const res = await fetch(GOOGLE_TOKEN_URL, {
      method: 'POST',
      headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
      body: body.toString(),
    });

    const data = await res.json();
    if (data.error) throw new Error(data.error_description || data.error);

    await authStore.setToken('youtube', {
      ...token,
      access_token: data.access_token,
      expires_at: Date.now() + (data.expires_in || 3600) * 1000,
    });
  }

  async getValidToken() {
    const token = await authStore.getToken('youtube');
    if (!token) throw new Error('YouTube not connected');
    if (Date.now() > token.expires_at - 60000) {
      await this.refreshToken();
      return authStore.getToken('youtube');
    }
    return token;
  }

  async fetchChannelInfo(accessToken) {
    const res = await fetch(
      `${YT_CHANNEL_URL}?part=snippet,statistics&mine=true&access_token=${accessToken}`
    );
    const data = await res.json();
    if (data.error) throw new Error(data.error.message);
    const channel = data.items?.[0];
    if (channel) await db.setSetting('youtube_channel', JSON.stringify(channel));
    return channel;
  }

  async uploadShort(videoBlob, metadata, onProgress = null) {
    const token = await this.getValidToken();
    const base = await getBackendBaseUrl();
    if (!base) throw new Error('Couldn\'t reach the server. Please refresh the page and try again.');

    // Initialize resumable session via backend to avoid CORS
    const initRes = await fetch(`${base}/api/youtube/init`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json; charset=UTF-8',
        Authorization: `Bearer ${token.access_token}`,
      },
      body: JSON.stringify({
        title: metadata.title || 'Short',
        description: metadata.description || '',
        tags: metadata.tags || [],
        categoryId: metadata.categoryId || '22',
        privacy: metadata.privacy || 'public',
        size: videoBlob.size,
      }),
    });

    const initData = await initRes.json().catch(() => ({}));
    if (!initRes.ok || !initData.sid) {
      throw new Error(initData.error || 'YouTube upload init failed');
    }

    return this.uploadChunkedViaProxy(base, initData.sid, videoBlob, onProgress);
  }

  async uploadChunkedViaProxy(base, sid, videoBlob, onProgress = null, abortSignal = null) {
    const totalSize = videoBlob.size;
    let offset = 0;
    const endpoint = `${base}/api/youtube/upload?sid=${encodeURIComponent(sid)}`;

    while (offset < totalSize) {
      const end = Math.min(offset + CHUNK_SIZE, totalSize);
      const chunk = videoBlob.slice(offset, end);

      // Use XMLHttpRequest for real-time progress updates
      const xhr = new XMLHttpRequest();
      xhr.open('PUT', endpoint);
      xhr.setRequestHeader('Content-Range', `bytes ${offset}-${end - 1}/${totalSize}`);
      xhr.setRequestHeader('Content-Type', 'video/mp4');

      let aborted = false;
      const aborter = () => { aborted = true; try { xhr.abort(); } catch {} };
      if (abortSignal) abortSignal.addEventListener('abort', aborter, { once: true });

      xhr.upload.onprogress = (e) => {
        if (!onProgress || !e.lengthComputable) return;
        const sentSoFar = offset + e.loaded;
        const ratio = sentSoFar / totalSize;
        onProgress(Math.round(ratio * 100));
      };

      const uploadPromise = new Promise((resolve, reject) => {
        xhr.onload = () => {
          if (xhr.status >= 200 && xhr.status < 300) {
            try {
              const data = JSON.parse(xhr.responseText);
              resolve({ status: xhr.status, data });
            } catch {
              resolve({ status: xhr.status, data: {} });
            }
          } else if (xhr.status === 308) {
            resolve({ status: 308, data: {} });
          } else {
            reject(new Error(`Upload chunk failed: ${xhr.status}`));
          }
        };
        xhr.onerror = () => {
          if (aborted) return reject(new DOMException('Aborted', 'AbortError'));
          reject(new Error('Network error during upload'));
        };
        xhr.ontimeout = () => {
          if (aborted) return reject(new DOMException('Aborted', 'AbortError'));
          reject(new Error('Upload timed out'));
        };
        xhr.send(chunk);
        xhr.onloadend = () => { if (abortSignal) try { abortSignal.removeEventListener('abort', aborter); } catch {} };
      });

      const result = await uploadPromise;

      if (result.status === 308) {
        const range = xhr.getResponseHeader('Range');
        if (range) {
          offset = parseInt(range.split('-')[1]) + 1;
        } else {
          offset = end;
        }
        if (onProgress) onProgress(Math.round((offset / totalSize) * 100));
        continue;
      }

      if (result.status >= 200 && result.status < 300) {
        if (onProgress) onProgress(100);
        const url = result.data.id ? `https://youtu.be/${result.data.id}` : null;
        return { videoId: result.data.id, url, data: result.data };
      }
    }
  }

  async uploadChunked(uploadUrl, videoBlob, onProgress = null) {
    const totalSize = videoBlob.size;
    let offset = 0;

    while (offset < totalSize) {
      const end = Math.min(offset + CHUNK_SIZE, totalSize);
      const chunk = videoBlob.slice(offset, end);

      const res = await fetch(uploadUrl, {
        method: 'PUT',
        headers: {
          'Content-Range': `bytes ${offset}-${end - 1}/${totalSize}`,
          'Content-Type': 'video/mp4',
        },
        body: chunk,
      });

      if (res.status === 308) {
        const range = res.headers.get('Range');
        if (range) {
          offset = parseInt(range.split('-')[1]) + 1;
        } else {
          offset = end;
        }
        if (onProgress) onProgress(Math.round((offset / totalSize) * 100));
        continue;
      }

      if (res.ok) {
        const data = await res.json();
        if (onProgress) onProgress(100);
        const url = data.id ? `https://youtu.be/${data.id}` : null;
        return { videoId: data.id, url, data };
      }

      const errData = await res.json().catch(() => ({}));
      throw new Error(errData.error?.message || `YouTube chunk upload failed: ${res.status}`);
    }
  }

  async disconnect() {
    try {
      const token = await authStore.getToken('youtube');
      const revoke = token?.refresh_token || token?.access_token;
      if (revoke) {
        const body = new URLSearchParams({ token: revoke });
        await fetch(GOOGLE_REVOKE_URL, {
          method: 'POST',
          headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
          body: body.toString(),
        }).catch(() => {});
      }
    } catch {}
    await authStore.removeToken('youtube');
    await db.setSetting('youtube_channel', null);
    await db.setSetting('google_oauth_state', null);
    await db.setSetting('google_oauth_verifier', null);
  }

  // Best-effort channel + recent video insights
  async getInsights(limit = 5) {
    const out = { channel: {}, recent: [] };
    try {
      const token = await this.getValidToken();
      try {
        const cRes = await fetch(`${YT_CHANNEL_URL}?part=snippet,statistics&mine=true`, {
          headers: { Authorization: `Bearer ${token.access_token}` },
        });
        const cData = await cRes.json();
        if (!cData.error && cData.items?.length) out.channel = cData.items[0];
      } catch {}

      try {
        const id = out.channel?.id;
        if (id) {
          const sRes = await fetch(`https://www.googleapis.com/youtube/v3/search?part=snippet&channelId=${id}&order=date&maxResults=${limit}&type=video`, {
            headers: { Authorization: `Bearer ${token.access_token}` },
          });
          const sData = await sRes.json();
          if (!sData.error) {
            out.recent = (sData.items || []).map(i => ({
              videoId: i.id?.videoId,
              title: i.snippet?.title,
              publishedAt: i.snippet?.publishedAt,
              url: i.id?.videoId ? `https://youtu.be/${i.id.videoId}` : null,
            }));
          }
        }
      } catch {}
    } catch {}
    return out;
  }
}

export const youtubeAPI = new YouTubeAPI();
