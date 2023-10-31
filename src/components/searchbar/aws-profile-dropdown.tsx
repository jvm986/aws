import { Icon, List } from "@raycast/api";
import { useEffect } from "react";
import { loadSharedConfigFiles } from "@aws-sdk/shared-ini-file-loader";
import { useCachedPromise, useCachedState, useExec } from "@raycast/utils";

interface Props {
  onProfileSelected?: VoidFunction;
}

export default function AWSProfileDropdown({ onProfileSelected }: Props) {
  const [selectedProfile, setSelectedProfile] = useCachedState<string>("aws_profile");
  const profileOptions = useProfileOptions();
  const vaultSessions = useVaultSessions();
  const isUsingAwsVault = !!vaultSessions;

  useEffect(() => {
    const isSelectedProfileInvalid =
      selectedProfile && !profileOptions.some((profile) => profile.name === selectedProfile);

    if (!selectedProfile || isSelectedProfileInvalid) {
      setSelectedProfile(profileOptions[0]?.name);
    }
  }, [profileOptions]);

  useAwsVault({
    profile: selectedProfile,
    onUpdate: () => onProfileSelected?.(),
  });

  useEffect(() => {
    if (selectedProfile && !isUsingAwsVault) {
      process.env.AWS_PROFILE = selectedProfile;
    } else {
      delete process.env.AWS_PROFILE;
    }

    if (selectedProfile) {
      process.env.AWS_REGION = profileOptions.find((profile) => profile.name === selectedProfile)?.region;
    }

    if (!vaultSessions?.includes(selectedProfile || "")) {
      delete process.env.AWS_VAULT;
    }

    onProfileSelected?.();
  }, [selectedProfile, isUsingAwsVault]);

  if (!profileOptions || profileOptions.length < 2) {
    return null;
  }

  return (
    <List.Dropdown tooltip="Select AWS Profile" value={selectedProfile} onChange={setSelectedProfile}>
      {profileOptions.map((profile) => (
        <List.Dropdown.Item key={profile.name} value={profile.name} title={profile.name} />
      ))}
    </List.Dropdown>
  );
}

const useVaultSessions = (): string[] | undefined => {
  const profileOptions = useProfileOptions();
  const { data: awsVaultSessions } = useExec("aws-sso", {
    env: { PATH: "/opt/homebrew/bin" },
    onError: () => undefined,
  });

  const activeSessions = awsVaultSessions
    ?.split(/\r?\n/)
    .filter(isRowWithActiveSession)
    .map((line) => line.trim().split(/\s+\|/)[3]?.trim());

  const activeSessionsFromMasterProfile = profileOptions
    .filter((profile) => profile.source_profile && activeSessions?.includes(profile.source_profile))
    .map((profile) => profile.name);

  return activeSessions && [...activeSessions, ...activeSessionsFromMasterProfile];
};

const useAwsVault = ({ profile, onUpdate }: { profile?: string; onUpdate: VoidFunction }) => {
  const { revalidate } = useExec("aws-sso", ["eval", "-p", profile as string], {
    execute: !!profile,
    env: { PATH: "/opt/homebrew/bin" },
    shell: true,
    onError: () => undefined,
    onData: (env) => {
      if (env) {
        // Parse and update process.env with the new env values
        const envLines = env.split(/\r?\n/);
        envLines.forEach((line) => {
          if (line.startsWith("export ")) {
            let [key, value] = line.slice(7).split("="); // Remove the 'export ' prefix and split
            // Remove double quotes from the value
            value = value.replace(/^"|"$/g, "");
            if (key && value) {
              process.env[key] = value;
              if (key === "AWS_SSO_PROFILE") {
                process.env.AWS_VAULT = value;
              }
              if (key === "AWS_DEFAULT_REGION") {
                process.env.AWS_REGION = value;
              }
            }
          }
        });

        onUpdate();
      }
    },
  });

  useEffect(() => {
    delete process.env.AWS_VAULT;
    revalidate();
  }, [profile]);
};

type ProfileOption = {
  name: string;
  region?: string;
  source_profile?: string;
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

const isRowWithActiveSession = (line: string): boolean => {
  return !(line.includes("=") || line.includes("Expires") || line.trim().endsWith("|") || !line.trim().length);
};
