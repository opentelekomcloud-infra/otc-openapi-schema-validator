export type SyncGranularityConfig = {
  onlyIfResponseHasContent?: boolean;
  contentTypes?: string[];
  mode?: "auto" | "perItem" | "allOrNothing";
  perItem?: {
    listFieldsAnyOf?: string[];
    statusFieldsAnyOf?: string[];
  };
  allOrNothing?: {
    markersAnyOf?: string[];
  };
};

export type PayloadConfig = {
  allowTopLevelArray?: boolean;
  allowObjectWrapperWithAnyArrayOfObjects?: boolean;
  allowActionEnumCreateDeleteWithTagsArray?: boolean;
  contentTypesPreferred?: string[];
};
