// Checks configuration for the chosen MODE and, in hybrid/live, that the WhatsApp token works.
import { configProblems, loadConfig, loadEnvFile } from '../src/config';

loadEnvFile();
const c = loadConfig();
console.log('MODE =', c.mode);
const p = configProblems(c);
if (p.length) { console.log('PROBLEMS:\n- ' + p.join('\n- ')); process.exit(1); }
if (c.mode === 'mock' || c.mode === 'sim') { console.log('OK. Run: npm run db:setup && npm run dev, then open http://localhost:' + c.port + '/sim'); process.exit(0); }
const r = await fetch(`https://graph.facebook.com/${c.wa.version}/${c.wa.phoneNumberId}?fields=display_phone_number,verified_name,quality_rating`, { headers: { Authorization: `Bearer ${c.wa.token}` } });
const j = (await r.json().catch(() => ({}))) as Record<string, any>;
console.log(r.ok ? 'WhatsApp token OK:' : 'WhatsApp check FAILED:', r.ok ? { number: j.display_phone_number, name: j.verified_name, quality: j.quality_rating } : j?.error?.message);
process.exit(r.ok ? 0 : 1);
