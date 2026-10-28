import { bridgeMethods } from "./bridge-methods";
import type { CloudNetworkLevel } from "./host";

/** Cloud editor. */
export interface CloudEnvironmentConfig {
  id: string;
  name: string;
  network: CloudNetworkLevel;
  allowedDomains: string[];
  includeDefaultDomains: boolean;
  variables: string;
  setupScript: string;
  updatedAt: number;
}

export type CloudEnvironmentInput = Omit<
  CloudEnvironmentConfig,
  "id" | "updatedAt"
> & { id?: string };

export interface CloudEnvironmentsAPI {
  listCloudEnvironments(): Promise<CloudEnvironmentConfig[]>;
  saveCloudEnvironment(
    input: CloudEnvironmentInput,
  ): Promise<CloudEnvironmentConfig>;
  archiveCloudEnvironment(id: string): Promise<void>;
}

export const cloudEnvironmentsMethods = bridgeMethods<CloudEnvironmentsAPI>({
  listCloudEnvironments: true,
  saveCloudEnvironment: true,
  archiveCloudEnvironment: true,
});

export const initialCloudEnvironment: CloudEnvironmentConfig = {
  id: "default",
  name: "Default",
  network: "trusted",
  allowedDomains: [],
  includeDefaultDomains: true,
  variables: "",
  setupScript: "",
  updatedAt: 0,
};
