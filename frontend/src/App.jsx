import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spinner } from './components/common/Feedback';
import ChatWidget from './components/chat/ChatWidget';
import { PREVIEW, SHOPPING } from './config';
import CategoryBar from './components/layout/CategoryBar';
import Footer from './components/layout/Footer';
import Navbar from './components/layout/Navbar';
import { ConsentBanner, PreviewBanner } from './components/layout/NoticeBars';
import PageToolbar from './components/layout/PageToolbar';
import SiteHeader from './components/layout/SiteHeader';
import { AuthModalProvider } from './context/AuthModalContext';
import ProtectedRoute from './components/routing/ProtectedRoute';
import ScrollToTop from './components/routing/ScrollToTop';
import { About, OpeningSoon, Privacy, Refunds, Shipping, Terms } from './pages/Legal';
import Home from './pages/Home';
import NotFound from './pages/NotFound';
import ProductDetail from './pages/ProductDetail';
import Products from './pages/Products';
import { initAnalytics, pageView } from './utils/analytics';

// Only the browsing pages ship in the main bundle; everything else loads when it's opened
const Account = lazy(() => import('./pages/Account'));
const Cart = lazy(() => import('./pages/Cart'));
const Checkout = lazy(() => import('./pages/Checkout'));
const Grocery = lazy(() => import('./pages/Grocery'));
const Help = lazy(() => import('./pages/Help'));
const Login = lazy(() => import('./pages/Login'));
const OrderDetail = lazy(() => import('./pages/OrderDetail'));
const Orders = lazy(() => import('./pages/Orders'));
const Sell = lazy(() => import('./pages/Sell'));
const Wishlist = lazy(() => import('./pages/Wishlist'));
const VisualSearch = lazy(() => import('./pages/VisualSearch'));

// Seller hub pages load on demand, so shoppers never download the charting library
const SellerLayout = lazy(() => import('./pages/seller/SellerLayout'));
const SellerOnboarding = lazy(() => import('./pages/seller/SellerOnboarding'));
const AnalyticsDashboard = lazy(() => import('./pages/seller/AnalyticsDashboard'));
const SellerProducts = lazy(() => import('./pages/seller/SellerProducts'));
const SellerOrders = lazy(() => import('./pages/seller/SellerOrders'));
const SellerEarnings = lazy(() => import('./pages/seller/SellerEarnings'));
const SellerSettings = lazy(() => import('./pages/seller/SellerSettings'));
const SellerSupport = lazy(() => import('./pages/seller/SellerSupport'));
const SellerCatalog = lazy(() => import('./pages/seller/SellerCatalog'));

// Pages that show the category strip under the navbar
const WITH_CATEGORY_BAR = ['/', '/products', '/grocery'];

const privateRoute = (element) => <ProtectedRoute>{element}</ProtectedRoute>;
const shopRoute = (element) => (SHOPPING ? privateRoute(element) : <OpeningSoon />);
// The Seller Hub runs on the api/ functions too; only its analytics dashboard needs the full API
const sellerRoute = (element) => (SHOPPING ? privateRoute(element) : <OpeningSoon />);

export default function App() {
  const { pathname, search } = useLocation();

  useEffect(initAnalytics, []);
  // Runs after the page's own useSeo effect (a child's effects run first), so the new title is reported
  useEffect(() => pageView(`${pathname}${search}`), [pathname, search]);

  return (
    <AuthModalProvider>
    <div className="app">
      <ScrollToTop />
      <PreviewBanner />
      <SiteHeader>
        <Navbar />
        {WITH_CATEGORY_BAR.includes(pathname) && <CategoryBar />}
      </SiteHeader>

      <main className="app-main">
        <PageToolbar />
        <Suspense fallback={<Spinner />}>
          <Routes>
            {/* Public */}
            <Route path="/" element={<Home />} />
            <Route path="/products" element={<Products />} />
            <Route path="/products/:id" element={<ProductDetail />} />
            <Route path="/products/:id/:slug" element={<ProductDetail />} />
            <Route path="/grocery" element={<Grocery />} />
            <Route path="/login" element={SHOPPING ? <Login /> : <OpeningSoon />} />
            <Route path="/register" element={SHOPPING ? <Login mode="register" /> : <OpeningSoon />} />
            <Route path="/help" element={<Help />} />
            <Route path="/sell" element={<Sell />} />
            <Route path="/visual-search" element={<VisualSearch />} />
            <Route path="/about" element={<About />} />
            <Route path="/privacy" element={<Privacy />} />
            <Route path="/terms" element={<Terms />} />
            <Route path="/refunds" element={<Refunds />} />
            <Route path="/shipping" element={<Shipping />} />

            {/* Logged-in users only */}
            <Route path="/cart" element={shopRoute(<Cart />)} />
            <Route path="/checkout" element={shopRoute(<Checkout />)} />
            <Route path="/orders" element={shopRoute(<Orders />)} />
            <Route path="/orders/:id" element={shopRoute(<OrderDetail />)} />
            <Route path="/wishlist" element={shopRoute(<Wishlist />)} />
            <Route path="/account" element={shopRoute(<Account />)} />

            {/* Seller hub (sellers & admins; customers are sent to onboarding) */}
            <Route path="/seller/register" element={sellerRoute(<SellerOnboarding />)} />
            <Route path="/seller" element={sellerRoute(<SellerLayout />)}>
              <Route index element={<Navigate to={PREVIEW ? 'products' : 'dashboard'} replace />} />
              <Route path="dashboard" element={PREVIEW ? <Navigate to="/seller/products" replace /> : <AnalyticsDashboard />} />
              <Route path="products" element={<SellerProducts />} />
              <Route path="orders" element={<SellerOrders />} />
              <Route path="earnings" element={<SellerEarnings />} />
              <Route path="settings" element={<SellerSettings />} />
              <Route path="support" element={<SellerSupport />} />
              <Route path="catalog" element={<SellerCatalog />} />
          </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>

      <Footer />
      {!PREVIEW && <ChatWidget />}
      <ConsentBanner />
    </div>
    </AuthModalProvider>
  );
}
