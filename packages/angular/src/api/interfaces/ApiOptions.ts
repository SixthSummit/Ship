/**
 * Options for API requests
 */
export interface ApiOptions {
  headers?: {
    [header: string]: string | string[];
  };
  observe?: undefined;
  params?: {
    [param: string]: string | number | boolean | string[];
  };
  reportProgress?: boolean;
  responseType?: 'json' | 'text' | 'blob' | 'arraybuffer';
  withCredentials?: boolean;
}
