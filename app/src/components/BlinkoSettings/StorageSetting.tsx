import { observer } from "mobx-react-lite";
import { Button, DropdownItem, DropdownMenu, DropdownTrigger, Dropdown, Input } from "@heroui/react";
import { RootStore } from "@/store";
import { BlinkoStore } from "@/store/blinkoStore";
import { ToastPlugin } from "@/store/module/Toast/Toast";
import { PromiseCall } from "@/store/standard/PromiseState";
import { Icon } from '@/components/Common/Iconify/icons';
import { api } from "@/lib/trpc";
import axiosInstance from "@/lib/axios";
import { getBlinkoEndpoint } from "@/lib/blinkoEndpoint";
import { Item } from "./Item";
import { useTranslation } from "react-i18next";
import { useEffect, useMemo } from "react";
import { PasswordInput } from "@/components/Common/PasswordInput";
import { CollapsibleCard } from "@/components/Common/CollapsibleCard";


export const StorageSetting = observer(() => {
  const { t } = useTranslation()
  const blinko = RootStore.Get(BlinkoStore)
  const toast = RootStore.Get(ToastPlugin)
  const store = RootStore.Local(() => ({
    s3AccessKeyId: "",
    s3AccessKeySecret: "",
    s3Endpoint: "",
    s3Region: "",
    s3Bucket: "",
    s3CustomPath: "",
    localCustomPath: "",
    googleDriveClientId: "",
    googleDriveClientSecret: "",
    googleDriveRefreshToken: "",
    googleDriveFolderId: "",
    googleDriveCustomPath: "",
    isAuthorizingGDrive: false,
    isTestingGDrive: false,
  }))

  const gdriveRedirectUri = useMemo(() => {
    try {
      return getBlinkoEndpoint('/api/gdrive/oauth/callback');
    } catch {
      return '/api/gdrive/oauth/callback';
    }
  }, []);

  useEffect(() => {
    store.s3AccessKeyId = blinko.config.value?.s3AccessKeyId || ""
    store.s3AccessKeySecret = blinko.config.value?.s3AccessKeySecret || ""
    store.s3Endpoint = blinko.config.value?.s3Endpoint || ""
    store.s3Region = blinko.config.value?.s3Region || ""
    store.s3Bucket = blinko.config.value?.s3Bucket || ""
    store.s3CustomPath = blinko.config.value?.s3CustomPath || ""
    store.localCustomPath = blinko.config.value?.localCustomPath || ""
    store.googleDriveClientId = blinko.config.value?.googleDriveClientId || ""
    store.googleDriveClientSecret = blinko.config.value?.googleDriveClientSecret || ""
    store.googleDriveRefreshToken = blinko.config.value?.googleDriveRefreshToken || ""
    store.googleDriveFolderId = blinko.config.value?.googleDriveFolderId || ""
    store.googleDriveCustomPath = blinko.config.value?.googleDriveCustomPath || ""
  }, [blinko.config.value])

  useEffect(() => {
    const expectedOrigin = new URL(getBlinkoEndpoint('/')).origin;
    const handleOAuthMessage = async (event: MessageEvent) => {
      if (event.origin !== expectedOrigin) return;
      if (event.data?.type !== 'blinko-gdrive-oauth') return;
      store.isAuthorizingGDrive = false;
      if (event.data.success) {
        await blinko.config.call();
        toast.success(t('google-drive-authorized-success'));
      } else {
        toast.error(event.data.message || t('google-drive-authorized-failed'));
      }
    };
    window.addEventListener('message', handleOAuthMessage);
    return () => window.removeEventListener('message', handleOAuthMessage);
  }, [blinko, toast, t]);

  const currentStorage = blinko.config.value?.objectStorage || 'local';
  const currentStorageLabel = currentStorage === 's3'
    ? 'S3'
    : currentStorage === 'gdrive'
      ? 'Google Drive'
      : t('local-file-system');

  const handleAuthorizeGoogleDrive = async () => {
    if (!store.googleDriveClientId.trim() || !store.googleDriveClientSecret.trim()) {
      toast.error(t('google-drive-credentials-required'));
      return;
    }
    store.isAuthorizingGDrive = true;
    try {
      await api.config.update.mutate({ key: 'googleDriveClientId', value: store.googleDriveClientId.trim() });
      await api.config.update.mutate({ key: 'googleDriveClientSecret', value: store.googleDriveClientSecret.trim() });
      const res = await axiosInstance.get(getBlinkoEndpoint('/api/gdrive/oauth/url'));
      const authUrl = res.data?.authUrl;
      if (!authUrl) {
        throw new Error('Missing OAuth URL');
      }
      const popup = window.open(authUrl, 'blinko-gdrive-oauth', 'width=560,height=680');
      if (!popup) {
        window.location.href = authUrl;
      }
    } catch (error: any) {
      store.isAuthorizingGDrive = false;
      toast.error(error?.response?.data?.error || error?.message || t('google-drive-authorized-failed'));
    }
  };

  const handleTestGoogleDrive = async () => {
    if (!store.googleDriveClientId.trim() || !store.googleDriveClientSecret.trim() || !store.googleDriveRefreshToken.trim()) {
      toast.error(t('google-drive-test-fields-required'));
      return;
    }
    store.isTestingGDrive = true;
    try {
      const res = await axiosInstance.post(getBlinkoEndpoint('/api/gdrive/test'), {
        clientId: store.googleDriveClientId.trim(),
        clientSecret: store.googleDriveClientSecret.trim(),
        refreshToken: store.googleDriveRefreshToken.trim(),
        folderId: store.googleDriveFolderId.trim() || undefined,
      });
      const email = res.data?.email || '';
      const folderName = res.data?.folderName ? ` (${res.data.folderName})` : '';
      toast.success(`${t('google-drive-connection-success')}${email ? `: ${email}${folderName}` : ''}`);
    } catch (error: any) {
      toast.error(error?.response?.data?.error || error?.message || t('google-drive-connection-failed'));
    } finally {
      store.isTestingGDrive = false;
    }
  };

  return <CollapsibleCard
    icon="tabler:brush"
    title={t('storage')}
  >
    <Item
      leftContent={<div className="flex flex-col gap-2">
        <div>{t('object-storage')}</div>
      </div>}
      rightContent={<div>
        <Dropdown>
          <DropdownTrigger>
            <Button startContent={<Icon icon="mdi:storage" width="20" height="20" />} color='primary' >
              {currentStorageLabel}
            </Button>
          </DropdownTrigger>
          <DropdownMenu onAction={async (key) => {
            await PromiseCall(api.config.update.mutate({
              key: 'objectStorage',
              value: key.toString()
            }), { autoAlert: false })
          }}>
            <DropdownItem key="local">{t('local-file-system')}</DropdownItem>
            <DropdownItem key="s3">S3</DropdownItem>
            <DropdownItem key="gdrive">Google Drive</DropdownItem>
          </DropdownMenu>
        </Dropdown>
      </div>} />

    {currentStorage !== 's3' && currentStorage !== 'gdrive' &&
      <Item
        leftContent={<>
          <div>{t('custom-path')}</div>
        </>}
        rightContent={<Input
          value={store.localCustomPath}
          onChange={e => store.localCustomPath = e.target.value}
          placeholder="/custom/path/"
          onBlur={async (e) => {
            await PromiseCall(api.config.update.mutate({
              key: 'localCustomPath',
              value: e.target.value
            }), { autoAlert: false })
          }} />}
      />
    }

    {
      currentStorage === 's3' && <>
        <Item
          leftContent={<>{t('access-key-id')}</>}
          rightContent={<PasswordInput
            value={store.s3AccessKeyId}
            onChange={e => store.s3AccessKeyId = e.target.value}
            placeholder={t('access-key-id')}
            onBlur={async (e) => {
              await PromiseCall(api.config.update.mutate({
                key: 's3AccessKeyId',
                value: e.target.value
              }), { autoAlert: false })
            }} />} />
        <Item
          leftContent={<>{t('access-key-secret')}</>}
          rightContent={<PasswordInput
            value={store.s3AccessKeySecret}
            onChange={e => store.s3AccessKeySecret = e.target.value}
            placeholder={t('access-key-secret')}
            onBlur={async (e) => {
              await PromiseCall(api.config.update.mutate({
                key: 's3AccessKeySecret',
                value: e.target.value
              }), { autoAlert: false })
            }} />} />
        <Item
          leftContent={<>{t('endpoint')}</>}
          rightContent={<Input value={store.s3Endpoint} onChange={e => store.s3Endpoint = e.target.value} placeholder="Endpoint" onBlur={async (e) => {
            await PromiseCall(api.config.update.mutate({
              key: 's3Endpoint',
              value: e.target.value
            }), { autoAlert: false })
          }} />} />
        <Item
          leftContent={<>{t('region')}</>}
          rightContent={<Input value={store.s3Region} onChange={e => store.s3Region = e.target.value} placeholder="Region" onBlur={async (e) => {
            await PromiseCall(api.config.update.mutate({
              key: 's3Region',
              value: e.target.value
            }), { autoAlert: false })
          }} />} />
        <Item
          leftContent={<>{t('bucket')}</>}
          rightContent={<Input value={store.s3Bucket} onChange={e => store.s3Bucket = e.target.value} placeholder="Bucket" onBlur={async (e) => {
            await PromiseCall(api.config.update.mutate({
              key: 's3Bucket',
              value: e.target.value
            }), { autoAlert: false })
          }} />} />
        <Item
          leftContent={<>
            <div>{t('custom-path')}</div>
          </>}
          rightContent={<Input
            value={store.s3CustomPath}
            onChange={e => store.s3CustomPath = e.target.value}
            placeholder="/custom/path/"
            onBlur={async (e) => {
              await PromiseCall(api.config.update.mutate({
                key: 's3CustomPath',
                value: e.target.value
              }), { autoAlert: false })
            }} />} />
      </>
    }

    {
      currentStorage === 'gdrive' && <>
        <Item
          leftContent={<div className="flex flex-col gap-1">
            <div>{t('google-drive-redirect-uri')}</div>
            <div className="text-xs text-default-400">{t('google-drive-redirect-uri-tip')}</div>
          </div>}
          rightContent={<div className="flex items-center gap-2 w-full">
            <Input
              isReadOnly
              value={gdriveRedirectUri}
            />
            <Button
              size="sm"
              variant="flat"
              onPress={() => {
                navigator.clipboard?.writeText(gdriveRedirectUri);
                toast.success(t('copied'));
              }}
            >
              {t('copy')}
            </Button>
          </div>}
        />
        <Item
          leftContent={<>{t('google-drive-client-id')}</>}
          rightContent={<Input
            value={store.googleDriveClientId}
            onChange={e => store.googleDriveClientId = e.target.value}
            placeholder="xxx.apps.googleusercontent.com"
            onBlur={async (e) => {
              await PromiseCall(api.config.update.mutate({
                key: 'googleDriveClientId',
                value: e.target.value.trim()
              }), { autoAlert: false })
            }} />} />
        <Item
          leftContent={<>{t('google-drive-client-secret')}</>}
          rightContent={<PasswordInput
            value={store.googleDriveClientSecret}
            onChange={e => store.googleDriveClientSecret = e.target.value}
            placeholder={t('google-drive-client-secret')}
            onBlur={async (e) => {
              await PromiseCall(api.config.update.mutate({
                key: 'googleDriveClientSecret',
                value: e.target.value.trim()
              }), { autoAlert: false })
            }} />} />
        <Item
          leftContent={<div className="flex flex-col gap-1">
            <div>{t('google-drive-refresh-token')}</div>
            <div className="text-xs text-default-400">{t('google-drive-refresh-token-tip')}</div>
          </div>}
          rightContent={<div className="flex items-center gap-2 w-full">
            <PasswordInput
              value={store.googleDriveRefreshToken}
              onChange={e => store.googleDriveRefreshToken = e.target.value}
              placeholder={t('google-drive-refresh-token')}
              onBlur={async (e) => {
                await PromiseCall(api.config.update.mutate({
                  key: 'googleDriveRefreshToken',
                  value: e.target.value.trim()
                }), { autoAlert: false })
              }} />
            <Button
              size="sm"
              color="primary"
              variant="flat"
              isLoading={store.isAuthorizingGDrive}
              onPress={handleAuthorizeGoogleDrive}
            >
              {t('google-drive-authorize')}
            </Button>
          </div>} />
        <Item
          leftContent={<div className="flex flex-col gap-1">
            <div>{t('google-drive-folder-id')}</div>
            <div className="text-xs text-default-400">{t('google-drive-folder-id-tip')}</div>
          </div>}
          rightContent={<Input
            value={store.googleDriveFolderId}
            onChange={e => store.googleDriveFolderId = e.target.value}
            placeholder={t('optional')}
            onBlur={async (e) => {
              await PromiseCall(api.config.update.mutate({
                key: 'googleDriveFolderId',
                value: e.target.value.trim()
              }), { autoAlert: false })
            }} />} />
        <Item
          leftContent={<>
            <div>{t('custom-path')}</div>
          </>}
          rightContent={<Input
            value={store.googleDriveCustomPath}
            onChange={e => store.googleDriveCustomPath = e.target.value}
            placeholder="/custom/path/"
            onBlur={async (e) => {
              await PromiseCall(api.config.update.mutate({
                key: 'googleDriveCustomPath',
                value: e.target.value
              }), { autoAlert: false })
            }} />} />
        <Item
          leftContent={<>{t('google-drive-test-connection')}</>}
          rightContent={<Button
            color="primary"
            variant="flat"
            isLoading={store.isTestingGDrive}
            onPress={handleTestGoogleDrive}
          >
            {t('google-drive-test-connection')}
          </Button>}
        />
      </>
    }

  </CollapsibleCard>
})