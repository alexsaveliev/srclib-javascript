var assert = require('assert'), execFile = require('child_process').execFile, fs = require('fs'), path = require('path');
var should = require('should');

require('./flatten_test');

describe('jsg output', function() {
  [
    {name: 'simple'},
    {name: 'builtin_origin'},
    {name: 'target_primitive'},
    {name: 'requirejs', args: ['--plugin', 'requirejs'], files: ['requirejs_b', 'requirejs']},
    {name: 'nodejs', args: ['--plugin', 'node']},
    {name: 'nodejs_module_export_func', args: ['--plugin', 'node']},
    {name: 'anonymous'},
  ].filter(function(test) { return new RegExp(process.env['F'] || '').test(test.name); }).forEach(function(test) {
    it(test.name + ' (with args: ' + (test.args || []).join(' ') + ')', function(done) {
      var expFile = './testdata/' + test.name + '.json';
      var want = require(expFile);
      var args = [path.join(__dirname, 'bin/jsg')];
      if (test.args) args.push.apply(args, test.args);
      (test.files || [test.name]).forEach(function(f) { args.push('testdata/' + f + '.js'); });
      execFile(process.execPath /* node */, args, function(err, stdout, stderr) {
        if (stderr) console.error(stderr);
        assert.ifError(err);
        var got = JSON.parse(stdout);
        if (process.env['EXP']) {
          var pp = JSON.stringify(got, null, 2);
          fs.writeFile(expFile, pp + '\n', function(err) {
            assert.ifError(err);
            assert(false); // don't let test pass when writing expectation
            done();
          });
          return;
        }
        if (process.env['DEBUG']) {
          console.log(JSON.stringify(got, null, 2));
          got.should.eql(want);
        } else {
          assert.deepEqual(got, want);
        }
        done();
      });
    });
  });
});
