import { HttpException, HttpStatus } from '@nestjs/common';
import type { ErrorCode } from '@guardia/shared';

const STATUS_BY_CODE: Record<ErrorCode, HttpStatus> = {
  VALIDATION_ERROR: HttpStatus.BAD_REQUEST,
  UNAUTHORIZED: HttpStatus.UNAUTHORIZED,
  FORBIDDEN: HttpStatus.FORBIDDEN,
  NOT_FOUND: HttpStatus.NOT_FOUND,
  CONFLICT: HttpStatus.CONFLICT,
  RATE_LIMITED: HttpStatus.TOO_MANY_REQUESTS,
  OTP_INVALID: HttpStatus.UNAUTHORIZED,
  OTP_EXPIRED: HttpStatus.UNAUTHORIZED,
  CONSENT_REQUIRED: HttpStatus.FORBIDDEN,
  ALERT_OUT_OF_COVERAGE: HttpStatus.UNPROCESSABLE_ENTITY,
  INVALID_TRANSITION: HttpStatus.CONFLICT,
  CANCEL_WINDOW_EXPIRED: HttpStatus.CONFLICT,
  UNIT_UNAVAILABLE: HttpStatus.CONFLICT,
  MEDIA_TOO_LARGE: HttpStatus.PAYLOAD_TOO_LARGE,
  PASSWORD_CHANGE_REQUIRED: HttpStatus.FORBIDDEN,
  ACCOUNT_RESTRICTED: HttpStatus.FORBIDDEN,
  ACCOUNT_BLOCKED: HttpStatus.FORBIDDEN,
  INTERNAL: HttpStatus.INTERNAL_SERVER_ERROR,
};

/** Error de dominio con código estable para el cliente. */
export class AppError extends HttpException {
  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super({ code, message, details }, STATUS_BY_CODE[code]);
  }
}
