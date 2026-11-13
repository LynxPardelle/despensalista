import * as cdk from 'aws-cdk-lib';

const legacyHost = 'despensalista.lynxpardelle.com';
const publicHost = 'despensalista.com';

export function publicProductionDomain(
  stack: cdk.Stack,
  projectName: string,
  stage: string,
) {
  const enabled = String(stack.node.tryGetContext('enablePublicProductionDomain'))
    .trim()
    .toLowerCase() === 'true';
  if (!enabled) return undefined;
  if (projectName !== 'despensalista' || stage !== 'prod') {
    throw new Error('The public production domain can only be enabled for DespensaLista prod.');
  }
  const certificateArn = String(stack.node.tryGetContext('publicProductionCertificateArn') ?? '').trim();
  const match = /^arn:aws:acm:us-east-1:(\d{12}):certificate\/[a-f\d-]{36}$/.exec(certificateArn);
  if (!match || (!cdk.Token.isUnresolved(stack.account) && match[1] !== stack.account)) {
    throw new Error('publicProductionCertificateArn must identify an ACM certificate in us-east-1 in this account.');
  }
  return {
    certificateArn,
    legacyHost,
    host: publicHost,
    wwwHost: `www.${publicHost}`,
    origin: `https://${publicHost}`,
  };
}

export type PublicProductionDomain = NonNullable<ReturnType<typeof publicProductionDomain>>;
