import { Icon, List } from "@raycast/api";
import { useEffect } from "react";
import { loadSharedConfigFiles } from "@aws-sdk/shared-ini-file-loader";
import { useCachedPromise, useCachedState, useExec } from "@raycast/utils";
import { getPreferenceValues } from "@raycast/api";

interface Props {
  onProfileSelected?: VoidFunction;
}

interface Preferences {
  awsAuthMethod: string;
}

type ProfileOption = {
  name: string;
  region?: string;
  source_profile?: string;
  credential_process?: string;
};

export default function AWSProfileDropdown({ onProfileSelected }: Props) {
  const preferences = getPreferenceValues<Preferences>();
  const [selectedProfile, setSelectedProfile] = useCachedState<string>("aws_selected_profile");
  const profileOptions = useProfileOptions();
  let availableSessions: string[] = [];

  switch (preferences.awsAuthMethod) {
    case "aws-vault":
      delete process.env.AWS_PROFILE;
      delete process.env.AWS_SSO;
      availableSessions = useVaultSessions();
      useAwsVault({
        profile: availableSessions.includes(selectedProfile || "") ? selectedProfile : undefined,
        onUpdate: () => onProfileSelected?.(),
      });
      break;
    case "aws-sso":
      delete process.env.AWS_PROFILE;
      delete process.env.AWS_VAULT;
      availableSessions = useSsoSessions();
      useAwsSso({
        profile: availableSessions.includes(selectedProfile || "") ? selectedProfile : undefined,
        onUpdate: () => onProfileSelected?.(),
      });
      break;
    default:
      delete process.env.AWS_VAULT;
      delete process.env.AWS_SSO;
      availableSessions = [];
      break;
  }

  useEffect(() => {
    if (selectedProfile && availableSessions.length === 0) {
      process.env.AWS_PROFILE = selectedProfile;
    } else {
      delete process.env.AWS_PROFILE;
    }

    if (selectedProfile) {
      process.env.AWS_REGION = profileOptions.find((profile) => profile.name === selectedProfile)?.region;
    }

    if (!availableSessions.includes(selectedProfile || "")) {
      delete process.env.AWS_VAULT;
      delete process.env.AWS_SSO;
    }

    onProfileSelected?.();
  }, [selectedProfile]);

  useEffect(() => {
    const isSelectedProfileInvalid =
      selectedProfile && !profileOptions.some((profile) => profile.name === selectedProfile);

    if (!selectedProfile || isSelectedProfileInvalid) {
      setSelectedProfile(profileOptions[0]?.name);
    }
  }, [profileOptions]);

  if (!profileOptions || profileOptions.length < 2) {
    return null;
  }

  return (
    <List.Dropdown tooltip="Select AWS Profile" value={selectedProfile} onChange={setSelectedProfile}>
      {profileOptions.map((profile) => {
        if (profile.credential_process?.includes("aws-sso") || profile.credential_process?.includes("aws-vault")) {
          return (
            <List.Dropdown.Item
              key={profile.name}
              value={profile.name}
              title={profile.name}
              icon={
                preferences.awsAuthMethod === "aws-vault"
                  ? availableSessions?.some((session) => session === profile.name)
                    ? Icon.LockUnlocked
                    : Icon.LockDisabled
                  : undefined
              }
            />
          );
        }
      })}
    </List.Dropdown>
  );
}

const useVaultSessions = (): string[] => {
  const profileOptions = useProfileOptions();
  const { data: awsVaultSessions } = useExec("aws-vault", ["list"], {
    env: { PATH: "/opt/homebrew/bin" },
    onError: (e) => console.log(e),
  });

  if (!awsVaultSessions || awsVaultSessions.trim() === "") {
    return [];
  }

  const activeSessions = awsVaultSessions
    .split(/\r?\n/)
    .filter(isVaultRowWithActiveSession)
    .map((line) => line.split(" ")[0]);

  if (activeSessions.length === 0) {
    return [];
  }

  const activeSessionsFromMasterProfile = profileOptions
    .filter((profile) => profile.source_profile && activeSessions.includes(profile.source_profile))
    .map((profile) => profile.name);

  return [...activeSessions, ...activeSessionsFromMasterProfile];
};

const useSsoSessions = (): string[] => {
  const profileOptions = useProfileOptions();
  const { data: awsSsoSessions } = useExec("aws-sso", {
    env: { PATH: "/opt/homebrew/bin" },
    onError: (e) => console.log(e),
  });

  if (!awsSsoSessions || awsSsoSessions.trim() === "") {
    return [];
  }

  const activeSessions = awsSsoSessions
    ?.split(/\r?\n/)
    .filter(isSsoRowWithAvailableSession)
    .map((line) => line.trim().split(/\s+\|/)[3]?.trim());

  if (activeSessions.length === 0) {
    return [];
  }

  const activeSessionsFromMasterProfile = profileOptions
    .filter((profile) => profile.source_profile && activeSessions?.includes(profile.source_profile))
    .map((profile) => profile.name);

  return activeSessions && [...activeSessions, ...activeSessionsFromMasterProfile];
};

const useAwsVault = ({ profile, onUpdate }: { profile?: string; onUpdate: VoidFunction }) => {
  const { revalidate } = useExec("aws-vault", ["exec", profile as string, "--json"], {
    execute: !!profile,
    env: { PATH: "/opt/homebrew/bin" },
    onError: (e) => console.log(e),
    onData: (awsCredentials) => {
      if (awsCredentials) {
        const { AccessKeyId, SecretAccessKey, SessionToken } = JSON.parse(awsCredentials) as {
          AccessKeyId: string;
          SecretAccessKey: string;
          SessionToken: string;
        };
        process.env.AWS_VAULT = profile;
        process.env.AWS_ACCESS_KEY_ID = AccessKeyId;
        process.env.AWS_SECRET_ACCESS_KEY = SecretAccessKey;
        process.env.AWS_SESSION_TOKEN = SessionToken;

        onUpdate();
      }
    },
  });

  useEffect(() => {
    delete process.env.AWS_VAULT;
    revalidate();
  }, [profile]);
};

const useAwsSso = ({ profile, onUpdate }: { profile?: string; onUpdate: VoidFunction }) => {
  const { revalidate } = useExec("aws-sso", ["eval", "-p", profile as string], {
    execute: !!profile,
    env: { PATH: "/opt/homebrew/bin:/usr/bin", SHELL: "/bin/sh" },
    shell: true,
    onError: () => undefined,
    onData: (env) => {
      if (env) {
        const envLines = env.split(/\r?\n/);
        envLines.forEach((line) => {
          if (line.startsWith("export ")) {
            let [key, value] = line.slice(7).split("=");
            value = value.replace(/^"|"$/g, "");
            if (key && value) {
              process.env[key] = value;
            }
          }
        });

        onUpdate();
      }
    },
  });

  useEffect(() => {
    delete process.env.AWS_SSO;
    revalidate();
  }, [profile]);
};

const useProfileOptions = (): ProfileOption[] => {
  const { data: configs = { configFile: {}, credentialsFile: {} } } = useCachedPromise(loadSharedConfigFiles);
  const { configFile, credentialsFile } = configs;

  const profileOptions =
    Object.keys(configFile).length > 0 ? Object.entries(configFile) : Object.entries(credentialsFile);

  return profileOptions.map(([name, config]) => {
    const includeProfile = configFile[name]?.include_profile;
    const region =
      configFile[name]?.region ||
      credentialsFile[name]?.region ||
      (includeProfile && configFile[includeProfile]?.region);

    return { ...config, region, name };
  });
};

const isSsoRowWithAvailableSession = (line: string): boolean => {
  return !(line.includes("=") || line.includes("Expires") || !line.trim().length);
};

const isVaultRowWithActiveSession = (line: string) =>
  (line.includes("sts.AssumeRole:") && !line.includes("sts.AssumeRole:-")) ||
  (line.includes("sts.GetSessionToken:") && !line.includes("sts.GetSessionToken:-"));
