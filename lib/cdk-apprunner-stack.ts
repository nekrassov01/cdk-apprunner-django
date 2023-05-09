import * as apprunner from "@aws-cdk/aws-apprunner-alpha";
import {
  App,
  Duration,
  RemovalPolicy,
  Stack,
  StackProps,
  Tags,
  aws_secretsmanager as asm,
  aws_apprunner,
  aws_ec2 as ec2,
  aws_ecr as ecr,
  aws_logs as logs,
  aws_rds as rds,
} from "aws-cdk-lib";
import { Destination, DockerImageDeployment, Source } from "cdk-docker-image-deployment";
import { Construct } from "constructs";

const app = new App();

const serviceName = "apprunner-demo";
const dbName = "test";
const dbUserName = "postgres";
const djangoUserName = "test-user";
const djangoUserEmail = "test@your-domain.com";
const secretExcludeCharacters = " % +~`#$&*()|[]{}:;<>?!'/@\"\\";
const domainName = app.node.tryGetContext("domain");
const djangoSecretKey = app.node.tryGetContext("djangoSecretKey");

export class AppRunnerDemoStack extends Stack {
  constructor(scope: Construct, id: string, props?: StackProps) {
    super(scope, id, props);

    /*****************
     * VPC
     *****************/

    // Base Vpc
    const vpc = new ec2.Vpc(this, "VPC", {
      ipAddresses: ec2.IpAddresses.cidr("10.0.0.0/24"),
      enableDnsHostnames: true,
      enableDnsSupport: true,
      natGateways: 0,
      maxAzs: 2,
      subnetConfiguration: [
        //{
        //  name: "Public",
        //  subnetType: ec2.SubnetType.PUBLIC,
        //  cidrMask: 26,
        //},
        {
          name: "Private",
          subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
          cidrMask: 26,
        },
      ],
    });
    //const vpcPublicSubnets = vpc.selectSubnets({
    //  subnetType: ec2.SubnetType.PUBLIC,
    //});
    const vpcPrivateSubnets = vpc.selectSubnets({
      subnetType: ec2.SubnetType.PRIVATE_ISOLATED,
    });

    /*****************
     * RDS
     *****************/

    const postgresListenerPort = 5432;
    const postgresEngine = rds.DatabaseClusterEngine.auroraPostgres({
      version: rds.AuroraPostgresEngineVersion.VER_15_2,
    });

    // Database cluster parameter group
    const dbClusterParameterGroup = new rds.ParameterGroup(this, "DBClusterParameterGroup", {
      engine: postgresEngine,
      description: `Cluster parameter group for ${serviceName}`,
      parameters: {
        "pgaudit.log": "all",
        "pgaudit.role": "rds_pgaudit",
        shared_preload_libraries: "pgaudit",
        timezone: "Asia/Tokyo",
      },
    });
    dbClusterParameterGroup.bindToCluster({});
    (
      dbClusterParameterGroup.node.defaultChild as rds.CfnDBClusterParameterGroup
    ).dbClusterParameterGroupName = `${serviceName}-db-cluster-pg-aurora-postgresql`;

    // Database instance parameter group
    const dbInstanceParameterGroup = new rds.ParameterGroup(this, "DBInstanceParameterGroup", {
      engine: postgresEngine,
      description: `Instance parameter group for ${serviceName}`,
    });
    dbInstanceParameterGroup.bindToInstance({});
    (
      dbInstanceParameterGroup.node.defaultChild as rds.CfnDBParameterGroup
    ).dbParameterGroupName = `${serviceName}-db-instance-pg-aurora-postgresql`;

    // Database subnet group
    const dbSubnetGroup = new rds.SubnetGroup(this, "DBSubnetGroup", {
      subnetGroupName: `${serviceName}-db-subnet-group`,
      description: `${serviceName}-db-subnet-group`,
      removalPolicy: RemovalPolicy.DESTROY,
      vpc: vpc,
      vpcSubnets: vpcPrivateSubnets,
    });

    // Database security group
    const dbSecurityGroupName = `${serviceName}-db-security-group`;
    const dbSecurityGroup = new ec2.SecurityGroup(this, "DBSecurityGroup", {
      securityGroupName: dbSecurityGroupName,
      description: dbSecurityGroupName,
      vpc: vpc,
      allowAllOutbound: true,
    });
    Tags.of(dbSecurityGroup).add("Name", dbSecurityGroupName);

    // Database credential
    const dbSecret = new asm.Secret(this, "DBSecret", {
      secretName: `${serviceName}-db-secret`,
      description: `Credentials for ${serviceName} database`,
      generateSecretString: {
        generateStringKey: "password",
        excludeCharacters: secretExcludeCharacters,
        passwordLength: 30,
        secretStringTemplate: JSON.stringify({ username: dbUserName }),
      },
    });

    // Django credential
    const djangoSecret = new asm.Secret(this, "DjangoSecret", {
      secretName: `${serviceName}-django-secret`,
      description: `Credentials for ${serviceName} django`,
      generateSecretString: {
        generateStringKey: "password",
        excludeCharacters: secretExcludeCharacters,
        passwordLength: 30,
        secretStringTemplate: JSON.stringify({
          username: djangoUserName,
          email: djangoUserEmail,
          secretkey: djangoSecretKey,
        }),
      },
    });

    // Aurora Serverless v2
    const dbCluster = new rds.DatabaseCluster(this, "DBCluster", {
      engine: postgresEngine,
      clusterIdentifier: `${serviceName}-db-cluster`,
      instanceIdentifierBase: `${serviceName}-db-instance`,
      instances: 1,
      defaultDatabaseName: dbName,
      deletionProtection: false,
      iamAuthentication: false,
      credentials: rds.Credentials.fromSecret(dbSecret),
      instanceProps: {
        vpc: vpc,
        vpcSubnets: vpcPrivateSubnets,
        instanceType: new ec2.InstanceType("serverless"),
        securityGroups: [dbSecurityGroup],
        parameterGroup: dbInstanceParameterGroup,
        enablePerformanceInsights: true,
        allowMajorVersionUpgrade: false,
        autoMinorVersionUpgrade: true,
        deleteAutomatedBackups: false,
        performanceInsightRetention: rds.PerformanceInsightRetention.DEFAULT,
        publiclyAccessible: false,
      },
      subnetGroup: dbSubnetGroup,
      parameterGroup: dbClusterParameterGroup,
      backup: {
        retention: Duration.days(1),
        preferredWindow: "17:00-17:30",
      },
      monitoringInterval: Duration.minutes(1),
      preferredMaintenanceWindow: "Sat:18:00-Sat:18:30",
      storageEncrypted: true,
      removalPolicy: RemovalPolicy.DESTROY,
      copyTagsToSnapshot: true,
      cloudwatchLogsExports: ["postgresql"],
      cloudwatchLogsRetention: logs.RetentionDays.THREE_MONTHS,
    });
    (dbCluster.node.defaultChild as rds.CfnDBCluster).serverlessV2ScalingConfiguration = {
      minCapacity: 0.5,
      maxCapacity: 2,
    };
    dbCluster.connections.allowInternally(
      ec2.Port.tcp(postgresListenerPort),
      "Allow resources with this security group connect to database"
    );
    dbCluster.connections.allowFrom(
      ec2.Peer.ipv4(vpc.vpcCidrBlock),
      ec2.Port.tcp(postgresListenerPort),
      "Allow resources in VPC connect to database"
    );

    // Lambda function for secrets rotation security group
    const secretRotationFunctionSecurityGroupName = `${serviceName}-secret-security-group`;
    const secretRotationFunctionSecurityGroup = new ec2.SecurityGroup(this, "DBSecretRotationFunctionSecurityGroup", {
      securityGroupName: secretRotationFunctionSecurityGroupName,
      description: secretRotationFunctionSecurityGroupName,
      vpc: vpc,
      allowAllOutbound: true,
    });
    Tags.of(secretRotationFunctionSecurityGroup).add("Name", secretRotationFunctionSecurityGroupName);

    dbCluster.connections.allowDefaultPortFrom(
      secretRotationFunctionSecurityGroup,
      "Allow DB secret rotation function connect to database"
    );

    // Database credential rotation
    new asm.SecretRotation(this, "DBSecretRotation", {
      application: asm.SecretRotationApplication.POSTGRES_ROTATION_SINGLE_USER,
      secret: dbSecret,
      target: dbCluster,
      vpc: vpc,
      automaticallyAfter: Duration.days(7),
      excludeCharacters: secretExcludeCharacters,
      securityGroup: secretRotationFunctionSecurityGroup,
      vpcSubnets: vpcPrivateSubnets,
    });

    // Django credential rotation
    new asm.SecretRotation(this, "DjangoSecretRotation", {
      application: asm.SecretRotationApplication.POSTGRES_ROTATION_SINGLE_USER,
      secret: djangoSecret,
      target: dbCluster,
      vpc: vpc,
      automaticallyAfter: Duration.days(7),
      excludeCharacters: secretExcludeCharacters,
      securityGroup: secretRotationFunctionSecurityGroup,
      vpcSubnets: vpcPrivateSubnets,
    });

    /*****************
     * AppRunner
     *****************/

    const tag = "latest";

    // Get ECR repository
    const containerRepository = ecr.Repository.fromRepositoryName(this, "ContainerRepository", "kawashima/django");

    // Deploy container image
    new DockerImageDeployment(this, "ImageDeploy", {
      source: Source.directory("src/image/django"),
      destination: Destination.ecr(containerRepository, {
        tag: tag,
      }),
    });

    // VPC Connector security group
    const vpcConnectorSecurityGroupName = `${serviceName}-vpc-connector-security-group`;
    const vpcConnectorSecurityGroup = new ec2.SecurityGroup(this, "VpcConnectorSecurityGroup", {
      securityGroupName: vpcConnectorSecurityGroupName,
      description: vpcConnectorSecurityGroupName,
      vpc: vpc,
      allowAllOutbound: true,
    });
    Tags.of(vpcConnectorSecurityGroup).add("Name", vpcConnectorSecurityGroupName);

    // VPC Connector
    const vpcConnector = new apprunner.VpcConnector(this, "VpcConnector", {
      vpcConnectorName: `${serviceName}-vpc-connector`,
      vpc: vpc,
      vpcSubnets: vpcPrivateSubnets,
      securityGroups: [vpcConnectorSecurityGroup],
    });
    vpcConnector.node.addDependency(dbCluster);

    dbCluster.connections.allowDefaultPortFrom(vpcConnectorSecurityGroup, "Allow App Runner connect to database");

    // AppRunner service
    const appRunnerService = new apprunner.Service(this, "AppRunnerService", {
      serviceName: `${serviceName}-service`, // Not working, probably because it's an alpha version.
      cpu: apprunner.Cpu.QUARTER_VCPU,
      memory: apprunner.Memory.HALF_GB,
      vpcConnector: vpcConnector,
      autoDeploymentsEnabled: true,
      source: apprunner.Source.fromEcr({
        repository: containerRepository,
        imageConfiguration: {
          environmentSecrets: {
            DB_USER: apprunner.Secret.fromSecretsManager(dbSecret, "username"),
            DB_PASSWORD: apprunner.Secret.fromSecretsManager(dbSecret, "password"),
            DB_HOST: apprunner.Secret.fromSecretsManager(dbSecret, "host"),
            DB_PORT: apprunner.Secret.fromSecretsManager(dbSecret, "port"),
            DB_NAME: apprunner.Secret.fromSecretsManager(dbSecret, "dbname"),
            DJANGO_SUPERUSER_USERNAME: apprunner.Secret.fromSecretsManager(djangoSecret, "username"),
            DJANGO_SUPERUSER_PASSWORD: apprunner.Secret.fromSecretsManager(djangoSecret, "password"),
            DJANGO_SUPERUSER_EMAIL: apprunner.Secret.fromSecretsManager(djangoSecret, "email"),
            DJANGO_SECRET_KEY: apprunner.Secret.fromSecretsManager(djangoSecret, "secretkey"),
          },
          environmentVariables: {
            DOMAIN: domainName,
          },
          port: 8080,
          startCommand: "bash docker-entrypoint.sh",
        },
        tagOrDigest: tag,
      }),
    });
    (appRunnerService.node.defaultChild as aws_apprunner.CfnService).serviceName = `${serviceName}-service`;
  }
}
