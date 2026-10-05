import { SetMetadata } from '@nestjs/common';

export const REQUIRED_ROLES = 'maxbio:roles';
export const IDENTITY_ONLY = 'maxbio:identity-only';
export const Roles = (...roles: ('ADMIN' | 'OPERATOR')[]) => SetMetadata(REQUIRED_ROLES, roles);
// Solo lifecycle de identidad. Los endpoints futuros requieren tenant por defecto.
export const IdentityOnly = () => SetMetadata(IDENTITY_ONLY, true);
