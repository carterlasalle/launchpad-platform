export interface DashboardApplication {
  application: string;
  displayName: string;
  owner: string;
  sync: string;
  health: string;
  deployment: string;
  productionUrl: string | null;
  updatedAt: string;
}
