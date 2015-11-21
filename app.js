var api = require('linode-api');
var exec = require('ssh-exec');
var Promise = require('bluebird');
var fs = require('fs');

function api_request(client, cmd, parameters) {
	return new Promise(function (resolve, reject) {
		client.call(cmd, parameters, function (err, res) {
			if (debug) {
				console.log(new Date(), cmd, parameters, err, res);
			}

			if (err) {
				return reject(err);
			}

			resolve(res);
		});
	});
}

function wait_for_job(client, linode_id, job_id) {
	var options = {
		'LinodeID': linode_id,
		'JobID': job_id
	};

	return api_request(client, 'linode.job.list', options)
		.then(function (res) {
			var job = res[0];

			if (job['HOST_FINISH_DT'] === '') {
				return wait_for_job(client, linode_id, job_id);
			}
		});
}

function create_linode(client, data_center_id, plan_id, distribution_id, kernel_id, disk_size, root_pass) {
	var linode_id;
	var disk_id;

	var options = {
		'DatacenterID': data_center_id,
		'PlanID': plan_id
	};

	console.log(new Date(), 'Creating linode...');

	return api_request(client, 'linode.create', options)
		.then(function (res) {
			linode_id = res['LinodeID'];

			var options = {
				'LinodeID': linode_id,
				'DistributionID': distribution_id,
				'Label': 'disk',
				'Size': disk_size,
				'rootPass': root_pass
			};

			console.log(new Date(), 'Creating disk...');

			return api_request(client, 'linode.disk.createfromdistribution', options);
		})
		.then(function (res) {
			disk_id = res['DiskID'];

			return wait_for_job(client, linode_id, res['JobID']);
		})
		.then(function () {
			var options = {
				'LinodeID': linode_id,
				'KernelID': kernel_id,
				'Label': 'profile',
				'DiskList': disk_id
			};

			console.log(new Date(), 'Creating configuration...');

			return api_request(client, 'linode.config.create', options);
		})
		.then(function (res) {
			var options = {
				'LinodeID': linode_id
			};

			console.log(new Date(), 'Booting linode...');

			return api_request(client, 'linode.boot', options);
		})
		.then(function (res) {
			return wait_for_job(client, linode_id, res['JobID']);
		})
		.then(function () {
			console.log(new Date(), 'Getting IP...');

			return get_ip_address(client, linode_id);
		});
}

function get_ip_address(client, linode_id) {
	var options = {
		'LinodeID': linode_id
	};

	return api_request(client, 'linode.ip.list', options)
		.then(function (res) {
			return res[0]['IPADDRESS'];
		});
}

function run_command(user, host, password, cmd) {
	var options = {
		'user': user,
		'host': host,
		'password': password
	};

	if (debug) {
		console.log(new Date(), 'Running command', user, host, password, cmd);
	}

	var s = exec(cmd, options);

	return new Promise(function (resolve, reject) {
		var buf = '';

		s.on('data', function (chunk) {
			buf += chunk;
		});

		s.on('end', function () {
			resolve(buf);
		});

		s.on('error', function (err) {
			reject(err);
		});
	});
}

function launch_instance(api_key, data_center_id, plan_id, distribution_id, kernel_id, disk_size, root_pass, cmd) {
	var client = new api.LinodeClient(api_key);

	var ip;

	return create_linode(client, data_center_id, plan_id, distribution_id, kernel_id, disk_size, root_pass)
		.then(function (res) {
			ip = res;

			console.log(new Date(), 'Sleeping...'); /* although linode says the host is ready, the connection gets refused if you do not sleep */

			return Promise.delay(10000);
		})
		.then(function () {
			console.log(new Date(), 'Running command...');

			return run_command('root', ip, root_pass, script);
		})
		.then(function () {
			console.log(new Date(), 'Deployed at ' + ip);
		});
}

function launch_instances(num_instances, api_key, data_center_id, plan_id, distribution_id, kernel_id, disk_size, root_pass, cmd) {
	var instances = [];

	for (var i = 0; i < num_instances; ++i) {
		instances.push(i);
	}

	return Promise.each(instances, function () {
		return launch_instance(api_key, data_center_id, plan_id, distribution_id, kernel_id, disk_size, root_pass, cmd);
	});
}

function delete_linode(client, linode_id) {
	var options = {
		'LinodeID': linode_id
	};

	console.log(new Date(), 'Shutting down...');

	return api_request(client, 'linode.shutdown', options)
		.then(function (res) {
			return wait_for_job(client, linode_id, res['JobID']);
		})
		.then(function () {
			var options = {
				'LinodeID': linode_id
			};

			return api_request(client, 'linode.disk.list', options)
		})
		.then(function (res) {
			if (res.length) {
				var disk_id = res[0]['DISKID'];

				var options = {
					'LinodeID': linode_id,
					'DiskID': disk_id
				};

				console.log(new Date(), 'Deleting disk...');

				return api_request(client, 'linode.disk.delete', options)
					.then(function (res) {
						return wait_for_job(client, linode_id, res['JobID']);
					});
			}	
		})
		.then(function () {
			var options = {
				'LinodeID': linode_id
			};

			console.log(new Date(), 'Deleting linode...');

			return api_request(client, 'linode.delete', options);
		});
}

function clean_account(api_key) {
	var client = new api.LinodeClient(api_key);

	return api_request(client, 'linode.list')
		.then(function (linodes) {
			return Promise.each(linodes, function (linode) {
				return delete_linode(client, linode['LINODEID']);
			});
		});
}

function check_linode(client, linode_id, root_pass, cmd) {
	var ip;

	return get_ip_address(client, linode_id)
		.then(function (res) {
			ip = res;

			console.log(new Date(), 'Checking linode...');

			return run_command('root', ip, root_pass, cmd);
		})
		.then(function (res) {
			console.log(new Date(), ip + ': ' + res);
		});
}

function check_instances(api_key, root_pass, check_cmd) {
	var client = new api.LinodeClient(api_key);

	return api_request(client, 'linode.list')
		.then(function (linodes) {
			return Promise.each(linodes, function (linode) {
				return check_linode(client, linode['LINODEID'], root_pass, check_cmd);
			});
		});
}

function change_cmd(client, linode_id, root_pass, cmd) {
	var ip;

	return get_ip_address(client, linode_id)
		.then(function (res) {
			ip = res;

			console.log(new Date(), 'Changing command...');

			return run_command('root', ip, root_pass, cmd);
		});
}

function update_instances(api_key, root_pass, cmd) {
	var client = new api.LinodeClient(api_key);

	return api_request(client, 'linode.list')
		.then(function (linodes) {
			return Promise.each(linodes, function (linode) {
				return change_cmd(client, linode['LINODEID'], root_pass, cmd);
			});
		});
}

function read_config() {
	return JSON.parse(fs.readFileSync('config.json').toString());
}

var debug = false;

var args = process.argv.slice(2);

Promise.resolve()
.then(function () {
	var config = read_config();

	if (args[0] === '--clean') {
		return clean_account(config['api_key']);
	}

	else if (args[0] === '--launch') {
		return launch_instances(config['num_instances'], config['api_key'], config['data_center_id'], config['plan_id'], config['distribution_id'], config['kernel_id'], config['disk_size'], config['root_pass'], config['launch_cmd']);
	}

	else if (args[0] === '--check') {
		return check_instances(config['api_key'], config['root_pass'], config['check_cmd']);
	}

	else if (args[0] === '--update') {
		return update_instances(config['api_key'], config['root_pass'], config['update_cmd']);
	}

	else {
		throw new Error('Usage: linode [--clean|--launch|--check|--update]');
	}
})
.then(function () {
	process.exit(0);
})
.catch(function (err) {
	console.error(err['stack'] ? err['stack'] : err);

	process.exit(1);
});