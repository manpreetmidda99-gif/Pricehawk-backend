// Typed HTTP errors. Routes throw these; the global error handler in
// src/index.ts converts them into the JSON error envelope.
export class HttpError extends Error {
  status: number;
  code: string;
  constructor(status: number, code: string, message: string) {
    super(message);
    this.status = status;
    this.code = code;
  }
}

export class BadRequestError extends HttpError {
  constructor(message: string) {
    super(400, "bad_request", message);
  }
}

export class UnauthorizedError extends HttpError {
  constructor() {
    super(401, "unauthorized", "Missing or invalid API key.");
  }
}

export class NotFoundError extends HttpError {
  constructor(message = "Not found.") {
    super(404, "not_found", message);
  }
}

/** The retailer refused the request (403/429/captcha). Never fake a price. */
export class BlockedError extends HttpError {
  constructor(message = "The retailer blocked this request.") {
    super(502, "blocked", message);
  }
}

/** A price exists on the page but can't be pinned down honestly. */
export class AmbiguousError extends HttpError {
  constructor(message: string) {
    super(422, "ambiguous", message);
  }
}

export class FetchError extends HttpError {
  constructor(message = "Failed to fetch the retailer page.") {
    super(502, "fetch_error", message);
  }
}

export class FxUnavailableError extends HttpError {
  constructor() {
    super(503, "fx_unavailable", "Live currency rates are unavailable.");
  }
}
