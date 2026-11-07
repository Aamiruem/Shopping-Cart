import { useLocation } from 'react-router-dom';
import { EmptyState } from '../components/common/Feedback';
import ProductCard from '../components/product/ProductCard';
import useSeo from '../hooks/useSeo';

// Results of searching with a photo. The search box sends them here in the navigation state.
export default function VisualSearch() {
  useSeo({ title: 'Search by photo', noindex: true });
  const { state } = useLocation();
  const results = state?.results;

  if (!results?.length) {
    return (
      <div className="container">
        <EmptyState
          icon="search"
          title={results ? 'No similar products found' : 'Search with a photo'}
          message="Tap the camera in the search box to find products that look like your photo."
          action={{ to: '/products', label: 'Browse products' }}
        />
      </div>
    );
  }

  return (
    <div className="page-listing container">
      <section className="listing panel">
        <h1>Products like your photo</h1>
        <div className="product-grid">
          {results.map((product) => <ProductCard key={product._id} product={product} />)}
        </div>
      </section>
    </div>
  );
}
