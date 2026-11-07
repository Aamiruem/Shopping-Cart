import { useEffect, useRef, useState } from 'react';
import { useNavigate, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { PREVIEW } from '../../config';
import { useToast } from '../../context/ToastContext';
import { formatPrice } from '../../utils/format';
import Icon from '../common/Icon';

// Navbar search with debounced product suggestions
export default function SearchBar() {
  const navigate = useNavigate();
  const toast = useToast();
  const [params] = useSearchParams();
  const [searching, setSearching] = useState(false);
  const [q, setQ] = useState(params.get('q') || '');
  const [suggestions, setSuggestions] = useState([]);
  const [open, setOpen] = useState(false);
  const boxRef = useRef(null);

  useEffect(() => setQ(params.get('q') || ''), [params]);

  useEffect(() => {
    const term = q.trim();
    if (term.length < 2) return setSuggestions([]);
    let cancelled = false;
    const timer = setTimeout(() => {
      api.products({ q: term, limit: 6, sort: 'popularity' })
        .then((list) => !cancelled && setSuggestions(list))
        .catch(() => !cancelled && setSuggestions([]));
    }, 250);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [q]);

  useEffect(() => {
    const onClick = (e) => !boxRef.current?.contains(e.target) && setOpen(false);
    document.addEventListener('mousedown', onClick);
    return () => document.removeEventListener('mousedown', onClick);
  }, []);

  const submit = (e) => {
    e.preventDefault();
    setOpen(false);
    navigate(q.trim() ? `/products?q=${encodeURIComponent(q.trim())}` : '/products');
  };

  const searchByPhoto = async (e) => {
    const [file] = e.target.files;
    e.target.value = '';
    if (!file) return;
    setSearching(true);
    try {
      navigate('/visual-search', { state: { results: await api.visualSearch(file) } });
    } catch (err) {
      toast.show(err.message, 'error');
    } finally {
      setSearching(false);
    }
  };

  const go = (path) => {
    setOpen(false);
    navigate(path);
  };

  return (
    <form className="searchbar" onSubmit={submit} ref={boxRef} role="search">
      <button type="submit" aria-label="Search"><Icon name="search" size={20} /></button>
      <input
        value={q}
        onChange={(e) => { setQ(e.target.value); setOpen(true); }}
        onFocus={() => setOpen(true)}
        onKeyDown={(e) => e.key === 'Escape' && setOpen(false)}
        placeholder="Search for Products, Brands and More"
        aria-label="Search products"
      />
      {!PREVIEW && (
        <label className="photo-search" aria-busy={searching} title="Search with a photo">
          <Icon name="camera" size={20} />
          <span className="sr-only">Search with a photo</span>
          <input type="file" accept="image/jpeg,image/png,image/webp" className="sr-only" onChange={searchByPhoto} disabled={searching} />
        </label>
      )}

      {open && suggestions.length > 0 && (
        <ul className="search-suggestions">
          {suggestions.map((p) => (
            <li key={p._id}>
              <button type="button" onClick={() => go(`/products/${p._id}`)}>
                <img src={p.image} alt="" />
                <span className="suggestion-name">{p.name}<small>in {p.brand || p.category}</small></span>
                <span className="suggestion-price">{formatPrice(p.price)}</span>
              </button>
            </li>
          ))}
          <li>
            <button type="button" className="suggestion-all" onClick={submit}>
              <Icon name="search" size={14} /> See all results for “{q.trim()}”
            </button>
          </li>
        </ul>
      )}
    </form>
  );
}
