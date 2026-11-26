import { lazy, Suspense, useEffect } from 'react';
import { Navigate, Route, Routes, useLocation, useParams } from 'react-router-dom';
import ErrorBoundary from './components/common/ErrorBoundary';
import { Spinner } from './components/common/Feedback';
import ChatWidget from './components/chat/ChatWidget';
import { PREVIEW, SHOPPING } from './config';
import CategoryBar from './components/layout/CategoryBar';
import Footer from './components/layout/Footer';
import Navbar from './components/layout/Navbar';
import { ConsentBanner, PreviewBanner } from './components/layout/NoticeBars';
import MobileTabBar, { showsTabBar } from './components/layout/MobileTabBar';
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
const Payments = lazy(() => import('./pages/Payments'));
const Orders = lazy(() => import('./pages/Orders'));
const Sell = lazy(() => import('./pages/Sell'));
const Wishlist = lazy(() => import('./pages/Wishlist'));
const VisualSearch = lazy(() => import('./pages/VisualSearch'));

// Seller hub pages load on demand, so shoppers never download the charting library
const SellerLayout = lazy(() => import('./pages/seller/SellerLayout'));
const SellerOnboarding = lazy(() => import('./pages/seller/SellerOnboarding'));
const AnalyticsDashboard = lazy(() => import('./pages/seller/AnalyticsDashboard'));
// Store mode: the dashboard reads the store API's own database (the ML dashboard needs the full Python API)
const StoreDashboard = lazy(() => import('./pages/seller/StoreDashboard'));
const SellerProducts = lazy(() => import('./pages/seller/SellerProducts'));
const SellerOrders = lazy(() => import('./pages/seller/SellerOrders'));
const SellerEarnings = lazy(() => import('./pages/seller/SellerEarnings'));
const SellerSettings = lazy(() => import('./pages/seller/SellerSettings'));
const SellerSupport = lazy(() => import('./pages/seller/SellerSupport'));
const SellerCatalog = lazy(() => import('./pages/seller/SellerCatalog'));
const SellerLeads = lazy(() => import('./pages/seller/SellerLeads'));

// CRM (store team only): its own bundle, never downloaded by shoppers
const CrmLayout = lazy(() => import('./pages/crm/CrmLayout'));
const CrmDashboard = lazy(() => import('./pages/crm/Dashboard'));
const CrmCustomers = lazy(() => import('./pages/crm/Customers'));
const CrmCustomer = lazy(() => import('./pages/crm/CustomerDetail'));
const CrmLeads = lazy(() => import('./pages/crm/Leads'));
const CrmSales = lazy(() => import('./pages/crm/Sales'));
const CrmInvoice = lazy(() => import('./pages/crm/Invoice'));
const CrmCatalog = lazy(() => import('./pages/crm/Catalog'));
const CrmMarketing = lazy(() => import('./pages/crm/Marketing'));
const CrmSupport = lazy(() => import('./pages/crm/Support'));
const CrmTasks = lazy(() => import('./pages/crm/Tasks'));
const CrmReports = lazy(() => import('./pages/crm/Reports'));
const CrmInsights = lazy(() => import('./pages/crm/Insights'));
const CrmTeam = lazy(() => import('./pages/crm/Team'));
const CrmSettings = lazy(() => import('./pages/crm/Settings'));
const Unsubscribe = lazy(() => import('./pages/Unsubscribe'));

// Pages that show the category strip under the navbar
const WITH_CATEGORY_BAR = ['/', '/products', '/grocery'];

const privateRoute = (element) => <ProtectedRoute>{element}</ProtectedRoute>;
const shopRoute = (element) => (SHOPPING ? privateRoute(element) : <OpeningSoon />);
// The Seller Hub runs on the api/ functions too; only its analytics dashboard needs the full API
const sellerRoute = (element) => (SHOPPING ? privateRoute(element) : <OpeningSoon />);

function ProductRedirect() {
  const { id, slug } = useParams();
  return <Navigate to={`/products/${id}${slug ? `/${slug}` : ''}`} replace />;
}

export default function App() {
  const { pathname, search } = useLocation();

  useEffect(initAnalytics, []);
  // Runs after the page's own useSeo effect (a child's effects run first), so the new title is reported
  useEffect(() => pageView(`${pathname}${search}`), [pathname, search]);

  return (
    <AuthModalProvider>
    <div className={`app ${showsTabBar(pathname) ? 'with-tabbar' : ''}`}>
      <ScrollToTop />
      <PreviewBanner />
      <SiteHeader>
        <Navbar />
        {WITH_CATEGORY_BAR.includes(pathname) && <CategoryBar />}
      </SiteHeader>

      <main className="app-main">
        <PageToolbar />
        <ErrorBoundary resetKey={pathname}>
        <Suspense fallback={<Spinner />}>
          <Routes>
            {/* Old and guessed addresses: /product/:id and /admin go to the real pages */}
            <Route path="/product/:id/:slug?" element={<ProductRedirect />} />
            <Route path="/admin/*" element={<Navigate to="/seller/dashboard" replace />} />
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
            {/* The cart works for guests too (kept in the browser until they sign in); checkout needs an account */}
            <Route path="/cart" element={SHOPPING ? <Cart /> : <OpeningSoon />} />
            <Route path="/checkout" element={shopRoute(<Checkout />)} />
            <Route path="/orders" element={shopRoute(<Orders />)} />
            <Route path="/orders/:id" element={shopRoute(<OrderDetail />)} />
            <Route path="/payments" element={shopRoute(<Payments />)} />
            <Route path="/wishlist" element={shopRoute(<Wishlist />)} />
            <Route path="/account" element={shopRoute(<Account />)} />

            {/* Seller hub (sellers & admins; customers are sent to onboarding) */}
            <Route path="/seller/register" element={sellerRoute(<SellerOnboarding />)} />
            <Route path="/seller" element={sellerRoute(<SellerLayout />)}>
              <Route index element={<Navigate to="dashboard" replace />} />
              <Route path="dashboard" element={PREVIEW ? <StoreDashboard /> : <AnalyticsDashboard />} />
              <Route path="products" element={<SellerProducts />} />
              <Route path="orders" element={<SellerOrders />} />
              <Route path="earnings" element={<SellerEarnings />} />
              <Route path="settings" element={<SellerSettings />} />
              <Route path="support" element={<SellerSupport />} />
              <Route path="catalog" element={<SellerCatalog />} />
              <Route path="leads" element={<SellerLeads />} />
          </Route>

            {/* CRM: hidden from everyone but the store team, and every API call is permission-checked on the server */}
            <Route path="/crm" element={sellerRoute(<CrmLayout />)}>
              <Route index element={<CrmDashboard />} />
              <Route path="customers" element={<CrmCustomers />} />
              <Route path="customers/:id" element={<CrmCustomer />} />
              <Route path="leads" element={<CrmLeads />} />
              <Route path="sales" element={<CrmSales />} />
              <Route path="invoice/:id" element={<CrmInvoice />} />
              <Route path="catalog" element={<CrmCatalog />} />
              <Route path="marketing" element={<CrmMarketing />} />
              <Route path="support" element={<CrmSupport />} />
              <Route path="tasks" element={<CrmTasks />} />
              <Route path="reports" element={<CrmReports />} />
              <Route path="insights" element={<CrmInsights />} />
              <Route path="team" element={<CrmTeam />} />
              <Route path="settings" element={<CrmSettings />} />
              <Route path="*" element={<Navigate to="/crm" replace />} />
            </Route>
            <Route path="/unsubscribe" element={<Unsubscribe />} />

            <Route path="*" element={<NotFound />} />
          </Routes>
        </Suspense>
        </ErrorBoundary>
      </main>

      <Footer />
      <MobileTabBar />
      <ChatWidget />
      <ConsentBanner />
    </div>
    </AuthModalProvider>
  );
}
