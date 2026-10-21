import { EmptyState } from '../components/common/Feedback';

export default function NotFound() {
  return (
    <div className="container">
      <EmptyState icon="search" title="Page not found" message="The page you are looking for doesn’t exist or has moved." action={{ to: '/', label: 'Go to home page' }} />
    </div>
  );
}
