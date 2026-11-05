// Saved overlay designs (text / stickers / images drawn in the designer).
//
// A design is stored as data (so it can be opened and edited again) plus the transparent PNG drawn from it
// (so a clip can be re-rendered later with exactly the same look, even after the server has forgotten the
// layer). Three kinds live here:
//   - the design a batch of clips was generated with (referenced from the upload and from re-rendered clips)
//   - named templates the person saved to reuse on other videos
//   - one auto-saved draft, so a page reload never loses a design in progress
import { db, STORES } from '../storage/db.js';
import { videoStore } from '../storage/videoStore.js';

const PREFIX = 'design:';
const DRAFT_KEY = `${PREFIX}draft`;

const newId = () => `d${Date.now().toString(36)}${Math.random().toString(36).slice(2, 7)}`;

export const designStore = {
  /**
   * Saves a design. `data` is the serialisable designer state; `layerBlob` the PNG drawn from it.
   * Returns the stored record ({ id, name, template, data, layerBlobId, ... }).
   */
  async save({ id = null, name = '', template = false, data, layerBlob = null, aspect = '9:16' }) {
    const recId = id || newId();
    let prev = null;
    try { prev = (await db.get(STORES.SETTINGS, `${PREFIX}${recId}`))?.value || null; } catch {}
    let layerBlobId = prev?.layerBlobId || null;
    if (layerBlob) {
      layerBlobId = `layer_${recId}`;
      await videoStore.saveBlob(layerBlobId, layerBlob, { kind: 'design-layer' });
    }
    const now = new Date().toISOString();
    const rec = {
      id: recId, name: name || prev?.name || '', template: !!template, aspect, data, layerBlobId,
      createdAt: prev?.createdAt || now, updatedAt: now,
    };
    await db.put(STORES.SETTINGS, { key: `${PREFIX}${recId}`, value: rec });
    return rec;
  },

  async get(id) {
    if (!id) return null;
    try { return (await db.get(STORES.SETTINGS, `${PREFIX}${id}`))?.value || null; } catch { return null; }
  },

  /** The PNG a design was drawn into, or null if it was never rendered / was cleared. */
  async getLayerBlob(id) {
    const rec = await this.get(id);
    if (!rec || !rec.layerBlobId) return null;
    try { return (await videoStore.getBlob(rec.layerBlobId)) || null; } catch { return null; }
  },

  /** Named templates, newest first. */
  async listTemplates() {
    let all = [];
    try { all = await db.getAll(STORES.SETTINGS); } catch {}
    return all
      .filter((r) => r && typeof r.key === 'string' && r.key.startsWith(PREFIX) && r.key !== DRAFT_KEY && r.value && r.value.template)
      .map((r) => r.value)
      .sort((a, b) => String(b.updatedAt).localeCompare(String(a.updatedAt)));
  },

  async remove(id) {
    const rec = await this.get(id);
    try { await db.delete(STORES.SETTINGS, `${PREFIX}${id}`); } catch {}
    if (rec && rec.layerBlobId) { try { await videoStore.deleteBlob?.(rec.layerBlobId); } catch {} }
  },

  // ── auto-saved draft (survives a page reload) ───────────────────────────────────────
  async saveDraft(data) {
    try { await db.put(STORES.SETTINGS, { key: DRAFT_KEY, value: { data, updatedAt: new Date().toISOString() } }); } catch {}
  },
  async loadDraft() {
    try { return (await db.get(STORES.SETTINGS, DRAFT_KEY))?.value?.data || null; } catch { return null; }
  },
  async clearDraft() {
    try { await db.delete(STORES.SETTINGS, DRAFT_KEY); } catch {}
  },
};
