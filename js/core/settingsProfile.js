// A settings file: everything you have set up, saved to one file you can load again in any browser or session, so nothing has to be
// set up twice.
//
//   processing   the Processing Settings of the Upload screen (clip length, number of clips, series, part overlay, shape, speed ...)
//   design       the look of the clips: framing, lower thirds, clip adjustments, captions look, and text / sticker overlays
//   presets      your saved clip-adjustment presets, caption looks and saved designs (with their pictures)
//   prefs        a few switches
//
// What belongs to one particular video is NOT in it (the video, its caption words, its title). Loading adds to your presets (the
// same name is updated, nothing else is removed) and replaces the processing settings and the design in front of you.
import { db, STORES } from '../storage/db.js';
import { designStore } from './designStore.js';
import { normalizeUserPresets } from '../shared/adjust.js';
import { normalizeUserTemplates } from '../shared/captions.js';

const KIND = 'settings-profile';
const VERSION = 1;
const MAX_BYTES = 12 * 1024 * 1024;
const FIELDS = {
  seriesMode: 'check', cloudProcessing: 'check', maxClips: 'num', seriesStartPart: 'num', clipDuration: 'num', overlayFormat: 'text', aspectRatio: 'text',
  origVolume: 'num', bgmVolume: 'num', bgmUrl: 'text', outputFormat: 'text', speedProfile: 'text',
  // (the fair-use acknowledgement is deliberately not saved: it has to be ticked each time)
};

const el = (id) => document.getElementById(id);
const blobToDataUrl = (blob) => new Promise((resolve) => { const r = new FileReader(); r.onload = () => resolve(String(r.result)); r.onerror = () => resolve(null); r.readAsDataURL(blob); });
const dataUrlToBlob = async (url) => { try { return await (await fetch(url)).blob(); } catch { return null; } };
async function readJsonSetting(key) { try { const raw = await db.getSetting(key); return raw ? JSON.parse(raw) : []; } catch { return []; } }
async function pad() { try { const m = await import('../ui/editor.js'); return m.editorUI && m.editorUI.pad ? m.editorUI.pad : null; } catch { return null; } }
const lsGet = (k) => { try { return localStorage.getItem(k); } catch { return null; } };
const lsSet = (k, v) => { try { localStorage.setItem(k, v); } catch { /* storage blocked */ } };

function readProcessing() {
  const out = {};
  for (const [id, type] of Object.entries(FIELDS)) {
    const e = el(id); if (!e) continue;
    out[id] = type === 'check' ? !!e.checked : (type === 'num' ? Number(e.value) : String(e.value));
  }
  return out;
}

function writeProcessing(p) {
  let n = 0;
  for (const [id, type] of Object.entries(FIELDS)) {
    const e = el(id); if (!e || !(id in (p || {}))) continue;
    const v = p[id];
    if (type === 'check') { if (e.checked !== !!v) { e.checked = !!v; e.dispatchEvent(new Event('change', { bubbles: true })); } n++; continue; }
    if (e.tagName === 'SELECT') { if (![...e.options].some((o) => o.value === String(v))) continue; e.value = String(v); }
    else if (type === 'num') { const x = Number(v); if (!Number.isFinite(x)) continue; e.value = String(x); } // a range input holds the value inside its own limits
    else e.value = String(v).slice(0, 500);
    e.dispatchEvent(new Event('input', { bubbles: true })); e.dispatchEvent(new Event('change', { bubbles: true }));
    n++;
  }
  return n;
}

export const settingsProfile = {
  /** Gathers everything into one object. */
  async build() {
    const p = await pad();
    let design = null;
    try { design = p ? p.serialize() : await designStore.loadDraft(); } catch { design = null; }
    if (design && Array.isArray(design.items)) design.items = design.items.filter((i) => !i || !i.blobId); // (pictures kept only when they are inside the item itself)
    const designs = [];
    for (const t of await designStore.listTemplates().catch(() => [])) {
      const rec = { name: t.name, aspect: t.aspect || '9:16', data: t.data };
      try { const b = await designStore.getLayerBlob(t.id); if (b && b.size < 3 * 1024 * 1024) rec.layerPng = await blobToDataUrl(b); } catch { /* no picture */ }
      designs.push(rec);
    }
    return {
      app: 'ClipperIQ Studio', kind: KIND, version: VERSION, savedAt: new Date().toISOString(),
      processing: readProcessing(),
      design,
      presets: { adjust: await readJsonSetting('clip_adjust_presets'), captionLooks: await readJsonSetting('caption_user_templates'), designs },
      prefs: { autoAspect: lsGet('clip_adjust_auto_aspect'), ltAutoPlay: lsGet('clipperiq.ltAutoPlay') },
    };
  },

  /** What a loaded file contains, for the confirmation question. Throws a readable error if it is not a settings file. */
  inspect(profile) {
    if (!profile || typeof profile !== 'object' || profile.kind !== KIND) throw new Error('That is not a ClipperIQ settings file.');
    if (Number(profile.version) > VERSION) throw new Error('That settings file was made by a newer version of ClipperIQ. Update the app first.');
    const d = profile.design || {};
    const lts = Array.isArray(d.lowerThirds) ? d.lowerThirds.filter((x) => x && x.enabled).length : (d.lowerThird && d.lowerThird.enabled ? 1 : 0);
    const parts = [];
    if (profile.processing && Object.keys(profile.processing).length) parts.push('the processing settings');
    if (profile.design) parts.push(`the design (${[d.frame ? 'framing' : '', lts ? `${lts} lower third${lts > 1 ? 's' : ''}` : '', d.captions && d.captions.enabled ? 'captions look' : '', Array.isArray(d.items) && d.items.length ? `${d.items.length} overlay${d.items.length > 1 ? 's' : ''}` : ''].filter(Boolean).join(', ') || 'as it was'})`);
    const pr = profile.presets || {};
    if (Array.isArray(pr.adjust) && pr.adjust.length) parts.push(`${pr.adjust.length} adjustment preset${pr.adjust.length > 1 ? 's' : ''}`);
    if (Array.isArray(pr.captionLooks) && pr.captionLooks.length) parts.push(`${pr.captionLooks.length} caption look${pr.captionLooks.length > 1 ? 's' : ''}`);
    if (Array.isArray(pr.designs) && pr.designs.length) parts.push(`${pr.designs.length} saved design${pr.designs.length > 1 ? 's' : ''}`);
    return { parts, savedAt: profile.savedAt };
  },

  /** Puts a settings file's contents in place. Returns a short summary of what was applied. */
  async apply(profile) {
    this.inspect(profile);
    const done = [];
    const merge = async (key, incoming, normalize) => {
      const have = await readJsonSetting(key);
      const clean = normalize(incoming);
      const byName = new Map(have.map((x) => [String(x.label).toLowerCase(), x]));
      for (const x of clean) byName.set(String(x.label).toLowerCase(), { ...x, id: (byName.get(String(x.label).toLowerCase()) || {}).id || x.id });
      const merged = normalize([...byName.values()]);
      await db.setSetting(key, JSON.stringify(merged));
      return clean.length;
    };
    const pr = profile.presets || {};
    if (Array.isArray(pr.adjust) && pr.adjust.length) done.push(`${await merge('clip_adjust_presets', pr.adjust, normalizeUserPresets)} adjustment preset(s)`);
    if (Array.isArray(pr.captionLooks) && pr.captionLooks.length) done.push(`${await merge('caption_user_templates', pr.captionLooks, normalizeUserTemplates)} caption look(s)`);
    if (Array.isArray(pr.designs) && pr.designs.length) {
      const have = await designStore.listTemplates().catch(() => []);
      let n = 0;
      for (const d of pr.designs.slice(0, 60)) {
        if (!d || typeof d.name !== 'string' || !d.data) continue;
        const layerBlob = d.layerPng ? await dataUrlToBlob(d.layerPng) : null;
        const same = have.find((h) => String(h.name).toLowerCase() === d.name.toLowerCase());
        await designStore.save({ id: same ? same.id : null, name: d.name.slice(0, 80), template: true, data: d.data, layerBlob, aspect: d.aspect || '9:16' });
        n++;
      }
      if (n) done.push(`${n} saved design(s)`);
    }
    if (profile.prefs) {
      if (profile.prefs.autoAspect === '0' || profile.prefs.autoAspect === '1') lsSet('clip_adjust_auto_aspect', profile.prefs.autoAspect);
      if (profile.prefs.ltAutoPlay === '0' || profile.prefs.ltAutoPlay === '1') lsSet('clipperiq.ltAutoPlay', profile.prefs.ltAutoPlay);
    }
    if (profile.processing && writeProcessing(profile.processing)) done.push('the processing settings');
    if (profile.design && typeof profile.design === 'object') {
      const design = { ...profile.design, items: Array.isArray(profile.design.items) ? profile.design.items : [] };
      await designStore.saveDraft(design);            // it is also what the editor starts from next time
      const p = await pad();
      if (p) { try { await p.load(design); } catch (e) { console.warn('[Settings] design could not be shown:', e); } }
      done.push('the design');
    }
    if (window.app && window.app.refreshDashboardSoon) { /* nothing on the dashboard depends on these */ }
    return { done };
  },

  /** "Download my settings": builds the file and saves it. */
  async download() {
    const profile = await this.build();
    const blob = new Blob([JSON.stringify(profile, null, 2)], { type: 'application/json' });
    const a = document.createElement('a');
    a.href = URL.createObjectURL(blob);
    a.download = `clipperiq-settings-${new Date().toISOString().slice(0, 10)}.json`;
    document.body.appendChild(a); a.click(); a.remove();
    setTimeout(() => URL.revokeObjectURL(a.href), 4000);
    return { bytes: blob.size, summary: this.inspect(profile) };
  },

  /** "Load settings from a file": asks for the file, shows what is in it, and applies it after the person agrees. */
  async pickAndLoad({ notify, confirmAction }) {
    const file = await new Promise((resolve) => {
      const input = document.createElement('input'); input.type = 'file'; input.accept = '.json,application/json';
      input.addEventListener('change', () => resolve(input.files && input.files[0] ? input.files[0] : null), { once: true });
      input.addEventListener('cancel', () => resolve(null), { once: true });
      input.click();
    });
    if (!file) return null;
    if (file.size > MAX_BYTES) { notify.error('That file is too big to be a settings file.'); return null; }
    let profile;
    try { profile = JSON.parse(await file.text()); } catch { notify.error('That file could not be read. Is it a ClipperIQ settings file (.json)?'); return null; }
    let info;
    try { info = this.inspect(profile); } catch (e) { notify.error(e.message); return null; }
    if (!info.parts.length) { notify.warn('That settings file has nothing in it.'); return null; }
    const ok = await confirmAction({
      title: 'Load these settings?',
      message: `This file${info.savedAt ? ` (saved ${new Date(info.savedAt).toLocaleDateString()})` : ''} has: ${info.parts.join('; ')}. Loading replaces the processing settings and the design in front of you, and adds the presets (one with the same name is updated). Nothing else is removed.`,
      confirmText: 'Load', cancelText: 'Cancel', intent: 'primary',
    });
    if (!ok) return null;
    const r = await this.apply(profile);
    notify.success(`Loaded: ${r.done.join(', ') || 'nothing to change'}.`);
    return r;
  },
};
