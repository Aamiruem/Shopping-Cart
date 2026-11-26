import { PageHead } from '../../components/crm/ui';
import { Audit as AuditTable } from './Settings';

// Audit logs: who did what in the CRM, the admin portal and the Seller Hub reviews
export default function Audit() {
  return (
    <>
      <PageHead title="Audit logs" subtitle="Sign-ins, failed sign-ins, MFA changes, customer and seller decisions, orders, refunds, permissions, settings and exports" />
      <AuditTable />
    </>
  );
}
