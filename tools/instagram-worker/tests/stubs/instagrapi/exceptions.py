"""Stub of instagrapi.exceptions with the real class names and roughly the real hierarchy (instagrapi 3.x)."""


class ClientError(Exception):
    pass


class ClientNotFoundError(ClientError):
    pass


class ClientLoginRequired(ClientError):
    pass


class ClientThrottledError(ClientError):
    pass


class PrivateError(ClientError):
    pass


class NotFoundError(PrivateError):
    pass


class MediaError(PrivateError):
    pass


class MediaNotFound(NotFoundError, MediaError):
    pass


class LoginRequired(PrivateError):
    pass


class ChallengeRequired(PrivateError):
    pass


class PleaseWaitFewMinutes(PrivateError):
    pass


class TwoFactorRequired(PrivateError):
    pass


class BadPassword(PrivateError):
    pass


class BadCredentials(PrivateError):
    pass
