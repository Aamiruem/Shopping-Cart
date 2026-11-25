import { useEffect, useState } from 'react';
import { api } from '../api/client';
import { PREVIEW } from '../config';

// Which one-time-code channels are connected: { email, sms, whatsapp }. The store API says (GET /auth/otp/channels);
// the full backend has no such route and offers every channel itself, so there a failed request means "all".
// Store mode never guesses: if the answer can't be fetched, no code option is shown.
const ALL = { email: true, sms: true, whatsapp: true };
const NONE = { email: false, sms: false, whatsapp: false };
let pending = null;

const load = () => {
  pending ??= api.otpChannels().catch(() => {
    pending = null; // try again next time
    return PREVIEW ? NONE : ALL;
  });
  return pending;
};

export default function useOtpChannels() {
  const [channels, setChannels] = useState(PREVIEW ? null : ALL);
  useEffect(() => {
    let live = true;
    load().then((c) => live && setChannels(c));
    return () => {
      live = false;
    };
  }, []);
  const ready = channels !== null;
  const c = channels || NONE;
  return { ...c, ready, mobile: c.sms || c.whatsapp, any: c.email || c.sms || c.whatsapp };
}
