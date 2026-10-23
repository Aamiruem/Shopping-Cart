import { lazy, Suspense } from 'react';
import { Navigate, Route, Routes, useLocation } from 'react-router-dom';
import { Spinner } from './components/common/Feedback';
import ChatWidget from './components/chat/ChatWidget';
import CategoryBar from './components/layout/CategoryBar';
import Footer from './components/layout/Footer';
import Navbar from './components/layout/Navbar';
import SiteHeader from './components/layout/SiteHeader';
import ProtectedRoute from './components/routing/ProtectedRoute';
import ScrollToTop from './components/routing/ScrollToTop';
import Account from './pages/Account';
import Cart from './pages/Cart';
import Checkout from './pages/Checkout';
import Grocery from './pages/Grocery';
import Help from './pages/Help';
import Home from './pages/Home';
import Login from './pages/Login';
import NotFound from './pages/NotFound';
import OrderDetail from './pages/OrderDetail';
import Orders from './pages/Orders';
import ProductDetail from './pages/ProductDetail';
import Products from './pages/Products';
import Sell from './pages/Sell';
import Wishlist from './pages/Wishlist';

// Seller hub pages load on demand, so shoppers never download the charting library
const SellerLayout = lazy(() => import('./pages/seller/SellerLayout'));
const SellerOnboarding = lazy(() => import('./pages/seller/SellerOnboarding'));
const AnalyticsDashboard = lazy(() => import('./pages/seller/AnalyticsDashboard'));
const SellerProducts = lazy(() => import('./pages/seller/SellerProducts'));
const SellerOrders = lazy(() => import('./pages/seller/SellerOrders'));
const SellerEarnings = lazy(() => import('./pages/seller/SellerEarnings'));
const SellerSettings = lazy(() => import('./pages/seller/SellerSettings'));

// Pages that show the category strip under the navbar
const WITH_CATEGORY_BAR = ['/', '/products', '/grocery'];

const privateRoute = (element) => <ProtectedRoute>{element}</ProtectedRoute>;

export default function App() {
  const { pathname } = useLocation();

  return (
    <div className="app">
      <ScrollToTop />
      <SiteHeader>
        <Navbar />
        {WITH_CATEGORY_BAR.includes(pathname) && <CategoryBar />}
      </SiteHeader>

      <main className="app-main">
        <Suspense fallback={<Spinner />}>
          <Routes>
            {/* Public */}
            <Route path="/" element={<Home />} />
            <Route path="/products" element={<Products />} />
            <Route path="/products/:id" element={<ProductDetail />} />
            <Route path="/products/:id/:slug" element={<ProductDetail />} />
            <Route path="/grocery" element={<Grocery />} />
            <Route path="/login" element={<Login />} />
            <Route path="/register" element={<Login mode="register" />} />
            <Route path="/help" element={<Help />} />
            <Route path="/sell" element={<Sell />} />

            {/* Logged-in users only */}
            <Route path="/cart" element={privateRoute(<Cart />)} />
            <Route path="/checkout" element={privateRoute(<Checkout />)} />
            <Route path="/orders" element={privateRoute(<Orders />)} />
            <Route path="/orders/:id" element={privateRoute(<OrderDetail />)} />
            <Route path="/wishlist" element={privateRoute(<Wishlist />)} />
            <Route path="/account" element={privateRoute(<Account />)} />

            {/* Seller hub (sellers & admins; customers are sent to onboarding) */}
            <Route path="/seller/register" element={privateRoute(<SellerOnboarding />)} />
            <Route path="/seller" element={privateRoute(<SellerLayout />)}>
              <Route index element={<Navigate to="dashboard" replace />} />
              <Route path="dashboard" element={<AnalyticsDashboard />} />
              <Route path="products" element={<SellerProducts />} />
              <Route path="orders" element={<SellerOrders />} />
              <Route path="earnings" element={<SellerEarnings />} />
              <Route path="settings" element={<SellerSettings />} />
             </Route>

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
      </main>

      <Footer />
      <ChatWidget />
    </div>
  );
}
