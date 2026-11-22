/**
 * The contracts barrel. Callers import `#src/shared/contracts`, which resolves here; `contracts.ts`
 * beside this directory holds the schemas and re-exports the ones that live in submodules.
 */
export * from '../contracts'
export * from './frames'
