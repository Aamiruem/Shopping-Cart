import { useLocation, useNavigate } from 'react-router-dom';
import { useToast } from '../../context/ToastContext';
import Icon from '../common/Icon';

// Back and Share on every page except home, like a shopping app's top bar. Product pages have their own Share
// beside the title, so this one hides there.
export default function PageToolbar() {
  const { pathname } = useLocation();
  const navigate = useNavigate();
  const toast = useToast();
  if (pathname === '/') return null;

  const productPage = /^\/products\/[^/]+/.test(pathname);
  // React Router counts in-app history: with none (a shared link opened directly), Back goes home instead of leaving
  const back = () => (window.history.state?.idx > 0 ? navigate(-1) : navigate('/'));

  const share = async () => {
    const url = window.location.href;
    if (navigator.share) {
      try {
        await navigator.share({ title: document.title, url });
      } catch { /* closed the share sheet */ }
      return;
    }
    try {
      await navigator.clipboard.writeText(url);
      toast.show('Link copied');
    } catch {
      toast.show('Couldn’t copy the link. Copy it from the address bar.', 'error');
    }
  };

  return (
    <div className="page-toolbar container">
      <button type="button" className="toolbar-btn" onClick={back} aria-label="Go back">
        <Icon name="chevronLeft" size={18} /> <span>Back</span>
      </button>
      {!productPage && (
        <button type="button" className="toolbar-btn" onClick={share} aria-label="Share this page">
          <Icon name="send" size={16} /> <span>Share</span>
        </button>
      )}
    </div>
  );
}
