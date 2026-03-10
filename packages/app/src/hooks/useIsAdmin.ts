import { useState, useEffect } from 'react';
import { useApi, identityApiRef } from '@backstage/core-plugin-api';

export const useIsAdmin = () => {
  const identityApi = useApi(identityApiRef);
  const [isAdmin, setIsAdmin] = useState(false);

  useEffect(() => {
    identityApi
      .getBackstageIdentity()
      .then(identity => {
        setIsAdmin(
          identity?.ownershipEntityRefs?.some(
            (ref: string) => ref === 'group:default/admins',
          ) ?? false,
        );
      })
      .catch(() => setIsAdmin(false));
  }, [identityApi]);

  return isAdmin;
};
