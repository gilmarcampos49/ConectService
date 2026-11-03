import { handleCheckPix } from '../_shared/handlers.ts';
import { buildContext } from '../_shared/context.ts';

Deno.serve((req) => handleCheckPix(req, buildContext()));
