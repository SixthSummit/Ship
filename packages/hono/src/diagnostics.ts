export type HonoAdapterDiagnosticCode =
  | "SHIP_HONO_TRANSPORT_INVALID"
  | "SHIP_HONO_INPUT_LOCATION_UNSUPPORTED"
  | "SHIP_HONO_PATH_PARAMS_MISMATCH"
  | "SHIP_HONO_REQUEST_BODY_MISMATCH"
  | "SHIP_HONO_AUTH_INVALID"
  | "SHIP_HONO_OPTIONS_INVALID"
  | "SHIP_HONO_CORS_INVALID"
  | "SHIP_HONO_WEBHOOK_BASE_URL_REQUIRED";

export class HonoAdapterError extends Error {
  readonly code: HonoAdapterDiagnosticCode;
  readonly operationId?: string;
  readonly inputLocation?: string;

  constructor(
    code: HonoAdapterDiagnosticCode,
    message: string,
    options: { readonly operationId?: string; readonly inputLocation?: string } = {},
  ) {
    super(message);
    this.name = "HonoAdapterError";
    this.code = code;
    this.operationId = options.operationId;
    this.inputLocation = options.inputLocation;
  }
}
