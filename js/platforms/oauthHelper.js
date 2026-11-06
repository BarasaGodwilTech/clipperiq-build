export class OAuthHelper {
  static generateRandomString(length = 64) {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789-._~';
    const arr = new Uint8Array(length);
    crypto.getRandomValues(arr);
    return Array.from(arr, (b) => chars[b % chars.length]).join('');
  }

  static async generatePKCE() {
    const verifier = this.generateRandomString(64);
    const data = new TextEncoder().encode(verifier);
    const digest = await crypto.subtle.digest('SHA-256', data);
    const challenge = btoa(String.fromCharCode(...new Uint8Array(digest)))
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/, '');
    return { verifier, challenge };
  }

  static openPopup(url, title = 'OAuth', width = 600, height = 700) {
    const left = window.screenX + (window.outerWidth - width) / 2;
    const top = window.screenY + (window.outerHeight - height) / 2;
    const popup = window.open(url, title, `width=${width},height=${height},left=${left},top=${top},toolbar=no,menubar=no,scrollbars=yes,resizable=yes`);
    
    try {
      if (!popup || popup.closed || typeof popup.closed === 'undefined') {
        throw new Error('Popup was blocked by your browser. Please allow popups for this site and try again.');
      }
    } catch (e) {
      if (e.message.includes('Popup was blocked')) {
        throw e;
      }
      // Ignore cross-origin error when reading popup.closed
      if (!popup) {
        throw new Error('Popup was blocked by your browser. Please allow popups for this site and try again.');
      }
    }
    
    return popup;
  }

  static waitForOAuthMessage(popup, expectedState, timeoutMs = 120000) {
    return new Promise((resolve, reject) => {
      let bc;
      try {
        bc = new BroadcastChannel('oauth_channel');
        bc.addEventListener('message', (e) => handler(e));
      } catch (e) {
        console.warn('BroadcastChannel not supported', e);
      }

      const storageHandler = (e) => {
        if (e.key === 'oauth_callback_data' && e.newValue) {
          try {
            const data = JSON.parse(e.newValue);
            handler({ data });
          } catch (err) {}
        }
      };
      window.addEventListener('storage', storageHandler);

      const timer = setTimeout(() => {
        cleanup();
        reject(new Error('OAuth timed out after 2 minutes'));
      }, timeoutMs);

      // We don't poll popup.closed aggressively because COOP same-origin makes it return true
      // when the popup navigates cross-origin. We rely on BroadcastChannel, storage events, or the timeout.

      function cleanup() {
        clearTimeout(timer);
        window.removeEventListener('message', handler);
        window.removeEventListener('storage', storageHandler);
        if (bc) bc.close();
      }

      function handler(event) {
        if (!event.data || event.data.type !== 'oauth_callback') return;
        if (event.data.state !== expectedState) return;
        cleanup();
        try {
          if (popup && !popup.closed) popup.close();
        } catch(e) {}
        if (event.data.error) {
          reject(new Error(event.data.error_description || event.data.error));
        } else {
          resolve(event.data);
        }
      }

      window.addEventListener('message', handler);
    });
  }

  static buildQueryString(params) {
    return Object.entries(params)
      .filter(([, v]) => v !== null && v !== undefined)
      .map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`)
      .join('&');
  }

  static getCallbackUrl() {
    return `${window.location.origin}/auth/callback.html`;
  }
}
