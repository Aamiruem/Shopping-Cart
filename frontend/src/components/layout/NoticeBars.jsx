import { useState } from 'react';
import { Link } from 'react-router-dom';
import { PREVIEW } from '../../config';
import { needsConsent, setConsent } from '../../utils/analytics';

// Shown on every page in preview mode, so nobody mistakes the sample catalog for live offers
export function PreviewBanner() {
  if (!PREVIEW) return null;
  return (
    <p className="preview-banner" role="status">
      <strong>Opening soon.</strong> This is a preview of Arvixa Store: prices, ratings and stock are samples and orders aren’t being taken yet.
    </p>
  );
}

// Only appears when Google Analytics is configured and the visitor hasn't chosen yet
export function ConsentBanner() {
  const [open, setOpen] = useState(needsConsent);
  if (!open) return null;
  const choose = (granted) => {
    setConsent(granted);
    setOpen(false);
  };
  return (
    <div className="consent-banner" role="dialog" aria-label="Cookie consent">
      <p>We use Google Analytics cookies to understand how the store is used. See our <Link to="/privacy">Privacy Policy</Link>.</p>
      <div className="consent-actions">
        <button type="button" className="consent-decline" onClick={() => choose(false)}>Decline</button>
        <button type="button" className="consent-accept" onClick={() => choose(true)}>Accept</button>
      </div>
    </div>
  );
}
