import { Fragment, useEffect, useState } from 'react';
import { Link, useSearchParams } from 'react-router-dom';
import { api } from '../../api/client';
import { AUDIENCES, CATEGORY_GROUPS, categoryLabel } from '../../constants/catalog';
import Icon from '../common/Icon';

const IMG = 'https://cdn.dummyjson.com/product-images';
// Women / Men fashion tiles sit right after "Fashion"
const AUDIENCE_IMAGES = {
  women: `${IMG}/womens-dresses/black-women's-gown/thumbnail.webp`,
  men: `${IMG}/mens-shirts/man-plaid-shirt/thumbnail.webp`,
};
const tilesFor = (group) => group.categories.flatMap((id) => [
  { key: id, label: categoryLabel(id), category: id, audience: '' },
  ...(id === 'fashion' ? AUDIENCES.map((a) => ({ key: a.id, label: a.label, category: 'fashion', audience: a.id, image: AUDIENCE_IMAGES[a.id] })) : []),
]);

// White strip under the navbar: the two category groups (Daily Use / General Use) and their categories
export default function CategoryBar() {
  const [images, setImages] = useState({});
  const [params] = useSearchParams();
  const active = { category: params.get('category') || '', audience: params.get('audience') || '', use: params.get('use') || '' };

  useEffect(() => {
    api.categories()
      .then((rows) => setImages(Object.fromEntries(rows.map((r) => [r.id, r.image]))))
      .catch(() => setImages({}));
  }, []);

  return (
    <nav className="category-bar" aria-label="Shop by category">
      <div className="container category-bar-inner">
        {CATEGORY_GROUPS.map((g, i) => (
          <Fragment key={g.id}>
            {i > 0 && <span className="category-divider" aria-hidden="true" />}
            <Link to={`/products?use=${g.id}`} className={`category-group ${active.use === g.id && !active.category ? 'active' : ''}`}>
              <span className="category-group-icon"><Icon name={g.icon} size={20} /></span>
              <span>{g.label}</span>
            </Link>
            {tilesFor(g).map((t) => {
              const src = t.image || images[t.category];
              const isActive = active.category === t.category && active.audience === t.audience;
              return (
                <Link
                  key={t.key}
                  to={`/products?category=${t.category}${t.audience ? `&audience=${t.audience}` : ''}`}
                  className={`category-tile ${isActive ? 'active' : ''}`}
                >
                  <span className="category-img">{src ? <img src={src} alt="" loading="lazy" /> : null}</span>
                  <span>{t.label}</span>
                </Link>
              );
            })}
          </Fragment>
        ))}
      </div>
    </nav>
  );
}
