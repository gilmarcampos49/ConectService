import { handleCreatePix } from '../_shared/handlers.ts';
import { buildContext } from '../_shared/context.ts';

Deno.serve((req) => handleCreatePix(req, buildContext()));
