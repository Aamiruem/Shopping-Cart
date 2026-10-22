import { Fragment } from 'react';
import { Link, useLocation, useSearchParams } from 'react-router-dom';
import { AUDIENCES, CATEGORY_GROUPS, categoryLabel } from '../../constants/catalog';

// Tab row under the header. Each tab knows its link and how to tell it is the current page.
const TABS = [
  { key: 'for-you', label: 'For You', to: '/', match: (l) => l.pathname === '/' },
  { key: 'all', label: 'All Products', to: '/products', match: (l, p) => l.pathname === '/products' && !['q', 'use', 'category', 'audience'].some((k) => p.get(k)) },
  ...CATEGORY_GROUPS.map((g) => ({
    key: g.id,
    group: g,
    tabs: g.categories.flatMap((id) => [
      id === 'grocery'
        ? { key: id, label: 'Grocery', to: '/grocery', match: (l) => l.pathname === '/grocery' }
        : { key: id, label: categoryLabel(id), to: `/products?category=${id}`, match: (l, p) => p.get('category') === id && !p.get('audience') },
      ...(id === 'fashion'
        ? AUDIENCES.map((a) => ({ key: a.id, label: a.label, to: `/products?category=fashion&audience=${a.id}`, match: (l, p) => p.get('audience') === a.id }))
        : []),
    ]),
  })),
];

export default function CategoryBar() {
  const location = useLocation();
  const [params] = useSearchParams();
  const tab = (t) => {
    const active = t.match(location, params);
    return (
      <Link key={t.key} to={t.to} className={`cat-tab ${active ? 'active' : ''}`} aria-current={active ? 'page' : undefined}>
        {t.label}
      </Link>
    );
  };

  return (
    <nav className="category-bar" aria-label="Shop by category">
      <div className="container category-tabs">
        {TABS.map((t) => (t.group ? (
          <Fragment key={t.key}>
            <span className="cat-divider" aria-hidden="true" />
            <Link
              to={`/products?use=${t.group.id}`}
              className={`cat-tab cat-group ${params.get('use') === t.group.id && !params.get('category') ? 'active' : ''}`}
              title={t.group.note}
            >
              {t.group.label}
            </Link>
            {t.tabs.map(tab)}
          </Fragment>
        ) : tab(t)))}
      </div>
    </nav>
  );
}
