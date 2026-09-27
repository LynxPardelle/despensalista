# Convenciones

## TypeScript

- Backend: comillas simples, punto y coma, Prettier y ESLint.
- Frontend: Angular templates modernos (`@if`, `@for`) y componentes OnPush
  cuando aplica.
- Se prefieren tipos de dominio/value objects frente a strings dentro del
  backend; los DTOs convierten en la frontera HTTP.
- Los errores de negocio usan excepciones Nest concretas y el filtro global
  produce una respuesta uniforme con request id.
- No se deben ocultar errores de persistencia como validacion del cliente.

## Nombres y archivos

- Casos de uso: `verb-noun.use-case.ts`.
- Adaptadores: `<provider>-<entity>.repository.ts`.
- Pruebas al lado del codigo: `*.spec.ts`; e2e backend en `backend/test` y
  navegador en `frontend/e2e`.
- Tokens de inyeccion centralizados en `backend/src/application/tokens.ts`.
- Clases y tipos en PascalCase; funciones, propiedades y claves en camelCase.
- Mensajes visibles al usuario en espanol; identificadores internos en ingles.

## Autorizacion

- Derivar identidad exclusivamente de Cognito/guard.
- Toda lectura por id debe comprobar pertenencia al usuario o acceso al hogar.
- No exponer tokens de invitacion o share en logs.
- Los datos locales del navegador que sobreviven una sesion deben estar
  versionados y ligados al `AuthUser.id`.

## Persistencia

- Mantener equivalencia entre DynamoDB y MongoDB para cada metodo de repositorio.
- En DynamoDB, usar `Query`/`Get` con claves documentadas; un `Scan` en una ruta
  de request necesita justificacion y paginacion explicita.
- Paginar hasta `LastEvaluatedKey`; `Limit` limita elementos evaluados, no
  necesariamente entidades del tipo esperado cuando una tabla es compartida.
- Las operaciones masivas deben ser reejecutables y reportar fallos parciales.

## Pruebas y cambios

- Para defectos y comportamiento nuevo: primero una prueba que falle, luego el
  cambio minimo y finalmente la suite relacionada.
- Antes de entregar: `npm ci`, auditoria de runtime, lint/build/unit/e2e y
  sintesis CDK de los tres stages.
- No usar `npm audit fix --force` para resolver advisories de tooling con un
  downgrade mayor; documentar el riesgo si no existe una actualizacion segura.
- `git diff --check` debe quedar limpio.

## Documentacion

- Especificaciones y decisiones historicas viven en `docs/superpowers/specs`.
- Revisiones puntuales viven en `docs/reviews`.
- La realidad operativa actual debe prevalecer sobre documentos historicos;
  marcar lo legado de forma explicita.
- No versionar secretos, contrasenas temporales, cookies ni tokens OAuth.
