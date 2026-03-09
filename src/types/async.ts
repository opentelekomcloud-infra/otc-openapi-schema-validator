export type AsyncResponseConfig = {
  asyncMatch?: {
    successStatusCode?: string;
  };
  require?: {
    statusCode?: string;
    jobIdAnyOf?: string[];
    resourcesListRequired?: boolean;
    resourcesListAnyOf?: string[];
  };
};
