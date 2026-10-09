/**
 * Document Ingestion Layer - Common Normalized Document Representation
 */

export interface DocumentTable {
  name?: string;
  headers: string[];
  rows: string[][];
}

export interface DocumentImageMeta {
  imageId: string;
  caption?: string;
  description?: string; // Visual description
  format?: string;
}

export interface DocumentMetadata {
  filename: string;
  mimeType: string;
  sizeBytes: number;
  extractedAt: string;
  pageCount?: number;
}

export interface DocumentContent {
  documentId: string;
  metadata: DocumentMetadata;
  text: string;
  tables: DocumentTable[];
  images: DocumentImageMeta[];
  sanitizedForAi: boolean; // True when credentials have been masked/extracted
}
